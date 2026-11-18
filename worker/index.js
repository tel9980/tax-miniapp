// 税优政策库 Worker
// 职责：抓取国家税务总局 + 广东省税务局政策 → 结构化 → 优惠判定 → 持久化到 KV → 返回 API
// 数据源：https://fgk.chinatax.gov.cn （全国）、https://guangdong.chinatax.gov.cn （广东）
// 同步机制：
//   1) cron 每天定时抓取（wrangler.toml [triggers]）
//   2) 用户访问时读 KV 秒出；KV 缺失/超过 1 小时则现场抓取兜底
//   3) /api/refresh 手动强制刷新

// ===== 栏目配置：官方「政策法规库」各栏目的 channelId（UUID，从各列表页 HTML 提取）=====
import { VAT_LAW, VAT_GROUPS, VAT_CONTINUITY, withUrl } from './vatContinuity.js';
import { CIT_LAW, CIT_GROUPS, CIT_CONTINUITY, citWithUrl } from './citContinuity.js';
import { IIT_LAW, IIT_GROUPS, IIT_CONTINUITY, iitWithUrl } from './iitContinuity.js';

const COLUMNS = [
  { code: 'c102416', name: '财税文件',         channelId: '2cb303fdee614232b79552d52bb057d6' },
  { code: 'c100012', name: '税务规范性文件',   channelId: '470b437b304f434396500a1e2edc7f28' },
  { code: 'c100006', name: '政策法规文件',     channelId: '29a88b67e4b149cfa9fac7919dfb08a5' },
  { code: 'c100009', name: '法律',             channelId: 'd34fa7ad03f84f4caed12f5c2beae099' },
  { code: 'c100010', name: '行政法规',         channelId: 'e1cd1569d1ea4a25a11041248925a081' },
  { code: 'c102440', name: '国务院文件',       channelId: 'fa1726b47078490fa0a4522194185e8d' },
  { code: 'c100013', name: '其他文件',         channelId: '4c1a5be62f6d44d48f386f630dcebbc5' },
  { code: 'c102424', name: '工作通知',         channelId: '7778c3a40a344de3a36ca88a2548f5f8' },
];

// ===== 广东省税务局政策栏目（列表为服务端渲染 HTML，直接解析 <ul class="infoList fileList">）=====
const GD_COLUMNS = [
  { path: '/gdsw/zcwj/zcwj.shtml', name: '广东·政策文件' },
  { path: '/gdsw/zxwj/zxwj.shtml', name: '广东·最新文件' },
];

// 每栏目抓取的最新条数（政策浏览只需要「最新」，抓 50 条足够覆盖近 1-2 年）
const PER_COLUMN = 50;

// KV 缓存有效期：24 小时（cron 每天抓一次，24h 内命中率最高；过期走 stale-while-revalidate 兜底）
const CACHE_TTL_MS = 24 * 3600 * 1000;

// 「新增」标记：记录每条政策首次被抓到的时间，7 天内视为新增（cron 每天对比 diff）
const SEEN_KEY = 'seen';
const NEW_DAYS = 7;

// ===== 优惠判定关键词（标题/文号命中即视为「税收优惠」政策）=====
const PREF_KEYWORDS = [
  '免征', '免税', '减征', '减半', '减按', '降税率', '降低税率', '减税',
  '退税', '即征即退', '先征后返', '留抵退税', '加计扣除', '抵免', '减免',
  '优惠', '零税率', '税收返还',
];

// 否定词：标题含这些词说明是「废止/取消/停止」类文件，不是优惠本身，需排除
const NEG_KEYWORDS = ['废止', '取消', '失效', '作废', '撤销', '不再执行', '不再实施', '停止执行', '终止执行'];

// 优惠类型 → 关键词
const PREF_TYPE_RULES = [
  ['免税', ['免征', '免税', '零税率']],
  ['减税', ['减征', '减半', '减按', '降税率', '降低税率', '减税']],
  ['退税', ['退税', '即征即退', '先征后返', '留抵退税']],
  ['扣除抵免', ['加计扣除', '抵免']],
  ['减免优惠', ['减免', '优惠', '税收返还']],
];

// 税种归一化映射（从官方 taxpolicy / labels 提取）
const TAX_TYPE_MAP = [
  ['增值税', ['增值税']],
  ['消费税', ['消费税']],
  ['企业所得税', ['企业所得税', '所得税']],
  ['个人所得税', ['个人所得税']],
  ['关税及进出口', ['进出口', '关税', '进口']],
  ['房产税', ['房产税']],
  ['城镇土地使用税', ['城镇土地使用税']],
  ['土地增值税', ['土地增值税']],
  ['车辆购置税', ['车辆购置税']],
  ['车船税', ['车船税']],
  ['印花税', ['印花税']],
  ['契税', ['契税']],
  ['资源税', ['资源税']],
  ['环境保护税', ['环境保护税', '环保税']],
];

// 内置高频核心优惠政策（全国），始终并入——用户搜索量最大、且不在「最新50条」抓取范围
const SEED_POLICIES = [
  { id: 'seed-vat-small', title: '增值税小规模纳税人起征点：月销售额10万元（季度30万元）以下不征增值税', docNo: '财政部 税务总局公告2026年第10号', date: '2026-01-30', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247434/content.html', taxTypes: ['增值税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '免税', column: '高频核心', region: '全国', plain: '小老板月销售额10万以内（季度30万以内）不用交增值税；按次纳税的每次（日）1000元以内也不用交。这是2026年增值税法施行后的新起征点，执行到2027年底。', summary: '《增值税法》2026年1月1日施行后，小规模纳税人起征点：按月计税的月销售额10万元、按季计税的季度销售额30万元、按次纳税的每次（日）销售额1000元。执行期间2026年1月1日至2027年12月31日。' },
  { id: 'seed-vat-1pct', title: '小规模纳税人适用3%征收率的应税交易减按1%征收率征收增值税', docNo: '财政部 税务总局公告2026年第10号', date: '2026-01-30', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247434/content.html', taxTypes: ['增值税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', column: '高频核心', region: '全国', plain: '小规模纳税人（不含卖房、出租不动产、转让土地使用权）本来要按3%交增值税，现在只按1%交，等于税率打了三折。执行到2027年底。', summary: '自2026年1月1日至2027年12月31日，小规模纳税人发生除销售、出租不动产或者转让土地使用权之外的增值税应税交易，依照3%征收率减按1%征收率征收增值税。' },
  { id: 'seed-sme', title: '小型微利企业减按25%计入应纳税所得额，按20%税率缴纳企业所得税（实际税负5%）', docNo: '财政部 税务总局公告2023年第12号', date: '2023-08-02', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5210453/content.html', taxTypes: ['企业所得税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', column: '高频核心', region: '全国', plain: '年利润300万以内的小微企业，企业所得税只按5%交（正常是25%，省了八成）。执行到2027年底。' },
  { id: 'seed-six', title: '增值税小规模纳税人、小型微利企业和个体工商户减半征收"六税两费"', docNo: '财政部 税务总局公告2023年第12号', date: '2023-08-02', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5210453/content.html', taxTypes: ['其他'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', column: '高频核心', region: '全国', plain: '小规模纳税人、小微企业、个体户的房产税、城建税、印花税等6种税+教育费附加，全部减半交。执行到2027年底。' },
  { id: 'seed-ger', title: '个体工商户年应纳税所得额不超过200万元的部分减半征收个人所得税', docNo: '财政部 税务总局公告2023年第12号', date: '2023-08-02', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5210453/content.html', taxTypes: ['个人所得税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', column: '高频核心', region: '全国', plain: '个体户一年赚的钱（应纳税所得额）200万以内，个人所得税减半交。执行到2027年底。' },
  { id: 'seed-rd', title: '研发费用税前加计扣除比例提高至100%', docNo: '财政部 税务总局公告2023年第7号', date: '2023-03-26', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5201978/content.html', taxTypes: ['企业所得税'], industry: '科技创新', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '扣除抵免', column: '高频核心', region: '全国', plain: '企业搞研发花的钱，报税时按2倍扣除（花100万能抵200万的税）。长期有效。' },
  { id: 'seed-bonus', title: '全年一次性奖金（年终奖）单独计税政策', docNo: '财政部 税务总局公告2023年第30号', date: '2023-08-18', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211524/content.html', taxTypes: ['个人所得税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', column: '高频核心', region: '全国', plain: '年终奖可以单独按月度税率算个税（不跟工资合并），通常比并入综合所得更省税。执行到2027年底。' },
  { id: 'seed-nev', title: '新能源汽车车辆购置税减免', docNo: '财政部 税务总局 工业和信息化部公告2023年第10号', date: '2023-06-19', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5207352/content.html', taxTypes: ['车辆购置税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局,工业和信息化部', isPreference: true, prefType: '免税', column: '高频核心', region: '全国', plain: '买新能源车：2024-2025年免征购置税，2026-2027年减半征收。每辆车最高能省3万元。' },
  { id: 'seed-deduction', title: '提高个人所得税专项附加扣除标准（子女教育、3岁以下婴幼儿照护、赡养老人）', docNo: '国家税务总局公告2023年第14号', date: '2023-08-30', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5213592/content.html', taxTypes: ['个人所得税'], industry: '社会民生', effectLevel: '税务规范性文件', department: '国家税务总局', isPreference: true, prefType: '扣除抵免', column: '高频核心', region: '全国', plain: '养娃和养老能少交税：子女教育每孩每月扣2000元（原1000）、3岁以下婴幼儿照护每孩每月扣2000元（原1000）、赡养老人独生子女每月扣3000元（原2000）。从2023年1月起算，长期有效。' },
  { id: 'seed-pension', title: '在全国范围实施个人养老金个人所得税优惠政策', docNo: '财政部 税务总局公告2024年第21号', date: '2024-12-12', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5237110/content.html', taxTypes: ['个人所得税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '扣除抵免', column: '高频核心', region: '全国', plain: '自己往个人养老金账户存钱（每年最多12000元），这部分钱当年不用交个税，等退休领钱时再按3%低税率交。长期有效。' },
  { id: 'seed-disabled', title: '促进残疾人就业增值税优惠（限额即征即退）', docNo: '财税〔2016〕52号', date: '2016-05-05', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5203716/content.html', taxTypes: ['增值税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '退税', column: '高频核心', region: '全国', plain: '企业招用残疾人上班，按实际安置人数，每人每月可按当地最低工资标准的4倍限额退还增值税。2026年新法施行后这条依然有效：财政部 税务总局公告2026年第10号第五条第五项把财税〔2016〕52号列入继续实施清单，执行至2027年底。', summary: '对安置残疾人的单位和个体工商户，按实际安置残疾人数限额即征即退增值税，每人每月退还限额为当地最低工资标准的4倍。依据财税〔2016〕52号，经财政部 税务总局公告2026年第10号第五条第五项列入继续实施清单，执行期间2026年1月1日至2027年12月31日。' },
];

// ===== 广东区域优惠核心（横琴/前海/南沙/大湾区，财税文件稳定、总局法规库收录不全，硬编码兜底）=====
// 说明：这些是广东本地税收优惠的「精华」，由财政部/税务总局统一发文、针对特定区域，
// 总局 fgk 的栏目分页与全文搜索对这部分收录不完整，因此内置保证专题一定展示核心内容。
const REGIONAL_SEED = [
  { id: 'seed-hq-cit15', title: '横琴粤澳深度合作区符合条件的产业企业减按15%税率征收企业所得税', docNo: '财税〔2022〕19号', date: '2022-01-27', url: null, taxTypes: ['企业所得税'], effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', region: '广东', area: '横琴', plain: '在横琴开公司，只要属于旅游、现代服务、高新技术等鼓励类产业，企业所得税按15%交（正常25%），省四成。', linkHint: '总局法规库未收录该文全文，点击进入政策库后用文号检索全文', summary: '对设在横琴粤澳深度合作区、符合《横琴粤澳深度合作区企业所得税优惠目录》的产业企业（旅游业、现代服务业、高新技术产业等），减按15%的税率征收企业所得税。' },
  { id: 'seed-qh-cit15', title: '前海深港现代服务业合作区符合条件的企业减按15%税率征收企业所得税', docNo: '财税〔2021〕30号', date: '2021-06-07', url: 'https://shenzhen.chinatax.gov.cn/sztax/zcwj/rdwd/202604/4c349af30b16481fb60e61ec868aff9c.shtml', taxTypes: ['企业所得税'], effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', region: '广东', area: '前海', plain: '在前海开公司，属于鼓励类产业的，企业所得税按15%交（正常25%）。', linkHint: '总局法规库未收录该文全文，点击进入政策库后用文号检索全文', summary: '对设在前海深港现代服务业合作区、符合《前海深港现代服务业合作区企业所得税优惠目录》的企业，减按15%的税率征收企业所得税。' },
  { id: 'seed-ns-cit15', title: '广州南沙先行启动区符合条件的鼓励类产业企业减按15%税率征收企业所得税', docNo: '财税〔2022〕40号', date: '2022-09-30', url: null, taxTypes: ['企业所得税'], effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', region: '广东', area: '南沙', plain: '在南沙（南沙湾、庆盛枢纽、南沙枢纽三个区块）开公司，属于鼓励类产业的，企业所得税按15%交（正常25%）。', linkHint: '总局法规库未收录该文全文，点击进入政策库后用文号检索全文', summary: '对设在南沙先行启动区（南沙湾、庆盛枢纽、南沙枢纽三个区块）符合条件的鼓励类产业企业，减按15%的税率征收企业所得税。' },
  { id: 'seed-dwq-iit', title: '粤港澳大湾区境外高端人才和紧缺人才个人所得税税负超15%部分免征', docNo: '财税〔2023〕34号', date: '2023-08-18', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211530/content.html', taxTypes: ['个人所得税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '大湾区', plain: '在珠三角九市工作的境外（含港澳台）高端人才，个税超过15%的部分由财政补回来，等于最多只交15%。已延续到2027年底。', summary: '对在粤港澳大湾区（珠三角九市）工作的境外（含港澳台）高端人才和紧缺人才，其个人所得税税负超过15%的部分给予财政补贴、予以免征。原政策财税〔2019〕31号，本文件延续至2027年底。' },
  { id: 'seed-hq-iit15', title: '横琴粤澳深度合作区高端人才和紧缺人才个人所得税税负超15%部分免征', docNo: '财税〔2022〕3号', date: '2022-01-27', url: null, taxTypes: ['个人所得税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '横琴', plain: '在横琴工作的境内外高端人才，个税超过15%的部分免征，等于最多只交15%。', linkHint: '总局法规库未收录该文全文，点击进入政策库后用文号检索全文', summary: '对在横琴粤澳深度合作区工作的境内外高端人才和紧缺人才，其个人所得税税负超过15%的部分予以免征。' },
  { id: 'seed-qh-iit15', title: '前海深港现代服务业合作区境外高端和紧缺人才个人所得税税负超15%部分免征', docNo: '财税〔2021〕29号', date: '2021-06-01', url: 'https://shenzhen.chinatax.gov.cn/sztax/zcwj/rdwd/202604/4c349af30b16481fb60e61ec868aff9c.shtml', taxTypes: ['个人所得税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '前海', plain: '在前海工作的境外高端人才，个税超过15%的部分由财政补回来，等于最多只交15%。', linkHint: '总局法规库未收录该文全文，点击进入政策库后用文号检索全文', summary: '对在前海深港现代服务业合作区工作的境外高端人才和紧缺人才，其个人所得税税负超过15%的部分给予财政补贴、予以免征。' },
  { id: 'seed-ns-iit15', title: '广州南沙港澳居民个人所得税税负超15%部分免征', docNo: '财税〔2022〕29号', date: '2022-09-01', url: null, taxTypes: ['个人所得税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '南沙', plain: '在广州南沙工作的港澳居民，个税超过港澳税负（15%）的部分免征。', linkHint: '总局法规库未收录该文全文，点击进入政策库后用文号检索全文', summary: '对在广州南沙工作的港澳居民，其个人所得税税负超过港澳税负（15%）的部分予以免征。' },
  { id: 'seed-hq-vat24', title: '横琴粤澳深度合作区调整有关增值税和消费税退税货物范围', docNo: '财税〔2024〕1号', date: '2024-01-11', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5220510/content.html', taxTypes: ['增值税', '消费税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '减税', region: '广东', area: '横琴', plain: '横琴合作区增值税和消费税退税货物范围调整，部分货物的退税待遇更优惠。', summary: '调整横琴粤澳深度合作区增值税和消费税退税货物的范围，明确合作区相关企业可享受的退税货物清单。' },
  { id: 'seed-hq-import24a', title: '横琴粤澳深度合作区货物有关进出口税收政策', docNo: '财关税〔2024〕1号', date: '2024-01-03', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5220339/content.html', taxTypes: ['关税'], effectLevel: '财税文件', department: '财政部,海关总署,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '横琴', plain: '横琴合作区符合条件的货物进出口享受免税、保税等税收优惠。', summary: '对横琴粤澳深度合作区符合条件的货物进出口，实行免税、保税等税收优惠政策。' },
  { id: 'seed-hq-import24b', title: '横琴粤澳深度合作区个人行李和寄递物品有关税收政策', docNo: '财关税〔2024〕2号', date: '2024-01-03', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5220336/content.html', taxTypes: ['关税'], effectLevel: '财税文件', department: '财政部,海关总署,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '横琴', plain: '横琴合作区个人行李和寄递物品享受免税额度等税收优惠。', summary: '对横琴粤澳深度合作区个人携带的行李物品和寄递物品，实行免税额度等税收优惠政策。' },
  { id: 'seed-dwq-vat20', title: '粤港澳大湾区实行有关增值税政策', docNo: '财税〔2020〕48号', date: '2020-10-26', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202178/content.html', taxTypes: ['增值税'], effectLevel: '财税文件', department: '财政部,海关总署,税务总局', isPreference: true, prefType: '减税', region: '广东', area: '大湾区', plain: '大湾区（珠三角九市）符合条件的行业享受增值税优惠政策。', summary: '对在粤港澳大湾区（珠三角九市）符合条件的行业，实行增值税优惠政策。' },
  { id: 'seed-ht-import26', title: '河套深港科技创新合作区深圳园区货物进出口有关税收政策', docNo: '财关税〔2026〕1号', date: '2026-01-09', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247134/content.html', taxTypes: ['关税'], effectLevel: '财税文件', department: '财政部,海关总署,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '河套', plain: '河套深港合作区深圳园区符合条件的货物进出口享受免税、保税等优惠。', summary: '对河套深港科技创新合作区深圳园区符合条件的货物进出口，实行免税、保税等税收优惠政策。' },
];

// ===== 区域关键词 → 用总局全文搜索接口自动补充最新区域政策 =====
const REGIONAL_KEYWORDS = [
  { kw: '横琴', area: '横琴' },
  { kw: '前海', area: '前海' },
  { kw: '南沙', area: '南沙' },
  { kw: '粤港澳大湾区', area: '大湾区' },
  { kw: '河套深港', area: '河套' },
];

// ===== 高频核心优惠政策有效期对照表（公开确定，标题常不含年份，用关键词补标）=====
// 这些是用户搜索量最大的政策，有效期稳定（2023 年「延续优化」系列，执行至 2027 年底）
const EFFECTIVE_UNTIL = [
  { match: ['增值税小规模纳税人起征点'], until: '2027-12-31' },
  { match: ['减按1%征收率'], until: '2027-12-31' },
  { match: ['小微企业和个体工商户发展有关税费'], until: '2027-12-31' },
  { match: ['小型微利企业减按25%'], until: '2027-12-31' },
  { match: ['六税两费'], until: '2027-12-31' },
  { match: ['个体工商户年应纳税所得额'], until: '2027-12-31' },
  { match: ['研发费用税前加计扣除'], until: '长期' },
  { match: ['全年一次性奖金'], until: '2027-12-31' },
  { match: ['新能源汽车车辆购置税'], until: '2027-12-31' },
  { match: ['专项附加扣除标准'], until: '长期' },
  { match: ['个人养老金'], until: '长期' },
  { match: ['加计抵减'], until: '2027-12-31' },
  { match: ['托育', '家政', '社区家庭'], until: '2027-12-31' },
  { match: ['公共租赁住房'], until: '2027-12-31' },
];

// ===== 工具函数 =====
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

// 从 domainMetaList 提取元数据 → key:value
function extractMeta(rec) {
  const meta = {};
  for (const dm of rec.domainMetaList || []) {
    for (const it of dm.resultList || []) {
      if (it.value) meta[it.key] = it.value;
    }
  }
  return meta;
}

// 提取税种（从 taxpolicy / labels，可能带"税收政策-"前缀）
function classifyTaxTypes(rec, meta) {
  const raw = [meta.taxpolicy || '', meta.labels || ''].join(',');
  const hits = new Set();
  for (const [tax, keys] of TAX_TYPE_MAP) {
    if (keys.some((k) => raw.includes(k))) hits.add(tax);
  }
  const title = rec.title || '';
  for (const [tax, keys] of TAX_TYPE_MAP) {
    if (keys.some((k) => title.includes(k))) hits.add(tax);
  }
  return hits.size ? [...hits] : ['其他'];
}

// 判定是否「税收优惠」+ 优惠类型
function classifyPreference(rec, meta) {
  const text = `${rec.title || ''} ${meta.writtentext || ''} ${meta.taxpolicy || ''} ${meta.labels || ''}`;
  const isPref = !NEG_KEYWORDS.some((k) => text.includes(k)) && PREF_KEYWORDS.some((k) => text.includes(k));
  let prefType = '';
  if (isPref) {
    for (const [type, keys] of PREF_TYPE_RULES) {
      if (keys.some((k) => text.includes(k))) { prefType = type; break; }
    }
    if (!prefType) prefType = '其他优惠';
  }
  return { isPref, prefType };
}

// 生成稳定 id（优先取原文链接里的 c 编号）
function genId(rec) {
  const m = /\/c(\d+)\/content\.html/.exec(rec.url || '');
  if (m) return m[1];
  let h = 0;
  const s = rec.url || rec.title || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36);
}

// 规范化原文链接：http→https，且政策法规库的 /zcfgk/ 路径域名从 www 换成 fgk
// （www.chinatax.gov.cn/zcfgk/... 是 404，正确域名是 fgk.chinatax.gov.cn）
function normalizeUrl(u) {
  u = (u || '').replace(/^http:\/\//, 'https://');
  u = u.replace(/^https:\/\/www\.chinatax\.gov\.cn\/zcfgk\//, 'https://fgk.chinatax.gov.cn/zcfgk/');
  return u;
}

// ===== 政策有效期解析（从标题/摘要提取截止日期，只标「能确定的」，不猜）=====
function parseExpiry(text, date) {
  if (!text) return null;
  let m;
  // 1. 「至/到/截止/有效期…YYYY年MM月DD日」→ 明确截止日
  m = text.match(/(?:至|到|截止|有效期|执行至|延续至|延长至|延至|延续到|延长到)\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  // 2. 「至/到/截止…YYYY年底」→ 该年 12 月 31 日
  m = text.match(/(?:至|到|截止|有效期|延续至|延长至|延至|执行至)\s*(\d{4})\s*年\s*底/);
  if (m) return `${m[1]}-12-31`;
  // 3. 「延续实施/继续实施/延长…YYYY年」（默认年底，常见于延续类文件标题）
  m = text.match(/(?:延续实施|延续执行|继续实施|继续执行|延长实施|延长执行)\s*(?:至|到)?\s*(\d{4})\s*年/);
  if (m && +m[1] >= 2000 && +m[1] <= 2100) return `${m[1]}-12-31`;
  // 4. 相对有效期：「有效期 X 年」（以成文日期为起点推算）
  m = text.match(/有效期\s*(\d{1,2})\s*年/);
  if (m && date) {
    const start = new Date(date);
    if (!isNaN(start)) {
      const end = new Date(Date.UTC(start.getUTCFullYear() + (+m[1]), start.getUTCMonth(), start.getUTCDate()));
      return end.toISOString().slice(0, 10);
    }
  }
  // 5. 「十五五」期间 → 2026-2030 规划期，截止 2030-12-31
  if (text.includes('十五五')) return '2030-12-31';
  // 6. 「十四五」期间 → 2021-2025 规划期，截止 2025-12-31
  if (text.includes('十四五')) return '2025-12-31';
  // 7. 「YYYY—YYYY年」范围式（如「2026—2027年」「2025年度—2027年度」）→ 取结束年份 12-31
  m = text.match(/(\d{4})\s*(?:年(?:度)?)?\s*[—–\-~至到]\s*(\d{4})\s*年/);
  if (m && +m[2] > +m[1] && +m[2] >= 2024 && +m[2] <= 2035) return `${m[2]}-12-31`;
  return null;
}

// 判定状态：已到期 / 即将到期（半年内）/ 生效中 / 未标注
function judgeStatus(expiryStr) {
  if (!expiryStr) return { expiry: null, status: '未标注' };
  const exp = new Date(expiryStr);
  if (isNaN(exp)) return { expiry: expiryStr, status: '未标注' };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((exp - today) / 86400000);
  if (days < 0) return { expiry: expiryStr, status: '已到期' };
  if (days <= 180) return { expiry: expiryStr, status: '即将到期' };
  return { expiry: expiryStr, status: '生效中' };
}

// 合并有效期信息到政策条目
function withExpiry(rec, text, date) {
  // seed/内置条目已显式声明状态（如因增值税法施行而停止执行），以声明为准
  if (rec.status) return rec;
  const { expiry, status } = judgeStatus(parseExpiry(text, date));
  rec.expiry = expiry;
  rec.status = status;
  // 标题没解析出有效期时，用高频核心政策对照表补（仅对确定性高的政策）
  if (status === '未标注') {
    for (const e of EFFECTIVE_UNTIL) {
      if (e.match.some((k) => text.includes(k))) {
        if (e.until === '长期') { rec.expiry = '长期'; rec.status = '生效中'; }
        else { const j = judgeStatus(e.until); rec.expiry = j.expiry; rec.status = j.status; }
        break;
      }
    }
  }
  return rec;
}

// 解析单条原始记录 → 政策条目
function parseRecord(rec, columnName) {
  const meta = extractMeta(rec);
  const { isPref, prefType } = classifyPreference(rec, meta);
  const title = (rec.title || '').trim();
  const date = meta.writtendate || (rec.publishedTimeStr || '').slice(0, 10);
  const out = withExpiry({
    id: genId(rec),
    title,
    docNo: meta.writtentext || '',
    date,
    url: normalizeUrl(rec.url || ''),
    taxTypes: classifyTaxTypes(rec, meta),
    industry: meta.industrytypename || '',
    effectLevel: meta.effectlevel || columnName,
    department: meta.writtendepartment || '',
    isPreference: isPref,
    prefType,
    column: columnName,
    region: '全国',
  }, `${title} ${meta.writtentext || ''} ${meta.summary || ''}`, date);
  // 官方元数据给了「废止日期」→ 优先标已废止（比有效期更准确）
  // 注意：官方 abolishdate 对未废止政策返回空串或字面量 "null"，需排除
  const abolish = (meta.abolishdate || '').trim();
  if (abolish && abolish !== 'null') {
    out.status = '已废止';
    out.expiry = abolish;
  }
  return out;
}

// ===== 广东税务局：抓取 + 解析（服务端渲染，直接解析 HTML 列表）=====
async function fetchGuangdongColumn(col) {
  const res = await fetch('https://guangdong.chinatax.gov.cn' + col.path, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const items = [];
  const re = /<li[^>]*>\s*<h4>\s*<a href="([^"]+)"(?:\s+title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>\s*<span class="time">([^<]+)<\/span>\s*<\/h4>\s*<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1], titleAttr = m[2], inner = m[3], date = (m[4] || '').trim().replace(/[\[\]\s]/g, '');
    const fm = /<font>([\s\S]*?)<\/font>/.exec(inner);
    const title = (fm ? fm[1] : (titleAttr || inner)).replace(/<[^>]+>/g, '').trim();
    if (!title || !href || !href.includes('content_')) continue;
    items.push({ title, date, url: 'https://guangdong.chinatax.gov.cn' + href, column: col.name });
  }
  return items;
}

function parseGdRecord(item) {
  const text = item.title || '';
  const isPref = !NEG_KEYWORDS.some((k) => text.includes(k)) && PREF_KEYWORDS.some((k) => text.includes(k));
  let prefType = '';
  if (isPref) {
    for (const [type, keys] of PREF_TYPE_RULES) {
      if (keys.some((k) => text.includes(k))) { prefType = type; break; }
    }
    if (!prefType) prefType = '其他优惠';
  }
  const hits = new Set();
  for (const [tax, keys] of TAX_TYPE_MAP) {
    if (keys.some((k) => text.includes(k))) hits.add(tax);
  }
  let h = 0;
  const s = item.url || item.title || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return withExpiry({
    id: 'gd-' + h.toString(36),
    title: text,
    docNo: '',
    date: item.date || '',
    url: item.url || '',
    taxTypes: hits.size ? [...hits] : ['其他'],
    industry: '',
    effectLevel: item.column || '广东',
    department: '广东省税务局',
    isPreference: isPref,
    prefType,
    column: item.column || '广东',
    region: '广东',
  }, text, item.date || '');
}

// ===== 总局全文搜索接口：按区域关键词自动补充最新区域政策 =====
// 接口：https://www.chinatax.gov.cn/search5/search/s（GET，返回 JSON searchResultAll.searchTotal）
function parseSearchRecord(item, area) {
  const title = (item.title || '').replace(/<[^>]+>/g, '').trim();
  if (!title || !item.url) return null;
  // 过滤搜索噪音：标题必须命中区域关键词
  const kw = area === '大湾区' ? ['大湾区', '粤港澳', '港澳'] : [area];
  if (!kw.some((k) => title.includes(k))) return null;
  const taxDiscount = Array.isArray(item.xxgk_taxDiscount) ? item.xxgk_taxDiscount.join(',') : (item.xxgk_taxDiscount || '');
  const taxPolicy = Array.isArray(item.xxgk_taxPolicy) ? item.xxgk_taxPolicy.join(',') : (item.xxgk_taxPolicy || '');
  const text = `${title} ${taxDiscount} ${taxPolicy}`;
  const isPref = !NEG_KEYWORDS.some((k) => text.includes(k)) && (PREF_KEYWORDS.some((k) => text.includes(k)) || !!taxDiscount);
  let prefType = '';
  if (isPref) {
    for (const [type, keys] of PREF_TYPE_RULES) {
      if (keys.some((k) => text.includes(k))) { prefType = type; break; }
    }
    if (!prefType) prefType = '其他优惠';
  }
  const hits = new Set();
  for (const [tax, keys] of TAX_TYPE_MAP) {
    if (keys.some((k) => `${taxPolicy} ${title}`.includes(k))) hits.add(tax);
  }
  const docNoRaw = (item.govDoc && item.govDoc.docNum) || item.indexno || '';
  const date = (item.cwrq || '').slice(0, 10);
  return withExpiry({
    id: genId({ url: item.url }),
    title,
    docNo: Array.isArray(docNoRaw) ? docNoRaw[0] : String(docNoRaw),
    date,
    url: normalizeUrl(item.url || ''),
    taxTypes: hits.size ? [...hits] : ['其他'],
    industry: item.xxgk_industryType || '',
    effectLevel: item.xxgk_effectLevel || item.label || '财税文件',
    department: (item.pubName || '').replace(/,/g, '、'),
    isPreference: isPref,
    prefType,
    column: '区域政策',
    region: '广东',
    area,
  }, `${title} ${item.govDoc && item.govDoc.docNum || ''}`, date);
}

async function fetchRegionalByKeyword(item) {
  const p = new URLSearchParams({
    searchWord: item.kw,
    siteCode: 'bm29000002',
    pageSize: '20',
    pageNum: '0',
    orderBy: '4',
    column: '政策法规,政策解读',
    label: '文字政策解读,法律,行政法规及国务院文件,税务部门规章,税务规范性文件,财税文件,其他文件',
    searchSiteName: 'GSFFK',
  });
  const url = 'https://www.chinatax.gov.cn/search5/search/s?' + p.toString();
  const opts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://fgk.chinatax.gov.cn/zcfgk/',
      'X-Requested-With': 'XMLHttpRequest',
    },
  };
  // 搜索接口偶发限流（返回 HTML 而非 JSON），失败指数退避重试最多 3 次
  let j = null;
  for (let attempt = 0; attempt < 3 && !j; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1200));
    try {
      const res = await fetch(url, opts);
      if (res.ok) {
        const txt = await res.text();
        try { j = JSON.parse(txt); } catch { /* 限流返回 HTML，下一轮重试 */ }
      }
    } catch {
      // 网络异常，下一轮重试
    }
  }
  if (!j) throw new Error('搜索接口连续失败');
  const list = j?.searchResultAll?.searchTotal || [];
  return list.map((it) => parseSearchRecord(it, item.area)).filter(Boolean);
}

// 抓取总局法规库详情页正文首段，生成简短「一句话看懂」摘要（无 AI，取正文开头的通知主旨）
async function fetchSummary(url) {
  try {
    if (!url) return '';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!res.ok) return '';
    const html = await res.text();
    // 正文容器：总局法规库 class="article"，广东省局 id="zoomcon"（fallback class="content"）
    let anchor = -1;
    for (const key of ['class="article"', 'id="zoomcon"', 'class="content"']) {
      const i = html.indexOf(key);
      if (i >= 0) { anchor = i; break; }
    }
    if (anchor < 0) return '';
    let text = html
      .slice(anchor, anchor + 5000)
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;|&ensp;/g, ' ')
      .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
      .replace(/&middot;/g, '·')
      .replace(/&mdash;|&ndash;/g, '—')
      .replace(/&lt;|&gt;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // 跳过开头的「注释」和收件单位等套话，从「现就/现将/通知如下/公告如下」开始
    const m = text.search(/现就|现将|通知如下|公告如下|规定如下/);
    if (m >= 0) text = text.slice(m);
    // 截断正文后的附加区块（广东页含「政策解读/相关政策文件/扫一扫」等链接区）
    const cut = text.search(/政策解读|相关政策文件|扫一扫|回到顶部|回到 顶部/);
    if (cut > 20) text = text.slice(0, cut).trim();
    if (!text) return '';
    return text.length > 160 ? text.slice(0, 160).replace(/\s+$/, '') + '…' : text;
  } catch {
    return '';
  }
}

// 基于元数据生成模板摘要（零子请求、零额外抓取，用于兜底没抓到正文的优惠政策）
function templatePlain(p) {
  const parts = [];
  if (p.prefType) parts.push(p.prefType);
  if (p.taxTypes && p.taxTypes.length) parts.push(p.taxTypes.join('、'));
  if (p.area) parts.push(`${p.area}区域`);
  if (p.expiry) parts.push(`执行至${p.expiry}`);
  const body = parts.length ? parts.join('，') : '税收优惠';
  return `${body}。具体条件与操作以原文为准。`;
}

// 抓取单个栏目
async function fetchColumn(channelId, size) {
  const body = new URLSearchParams({
    codeId: '',
    channelId,
    page: '1',
    size: String(size),
  });
  const res = await fetch('https://www.chinatax.gov.cn/getFileListByCodeId', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://fgk.chinatax.gov.cn/zcfgk/',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data?.results?.data?.results || [];
}

// 抓取全部（全国 + 广东 + 区域搜索，并行）→ 结构化 → 去重 → 排序
async function fetchAll() {
  // 全国（总局 fgk 接口）
  const results = await Promise.allSettled(
    COLUMNS.map((col) => fetchColumn(col.channelId, PER_COLUMN).then((recs) => recs.map((r) => parseRecord(r, col.name))))
  );
  // 广东（省局 HTML）
  const gdResults = await Promise.allSettled(
    GD_COLUMNS.map((col) => fetchGuangdongColumn(col).then((items) => items.map((it) => parseGdRecord(it))))
  );
  // 区域优惠（总局全文搜索接口，按横琴/前海/南沙/大湾区/河套关键词补充最新政策）
  // 串行 + 间隔，避免 5 个搜索请求并发触发总局接口反爬限流
  const regionalResults = [];
  for (const item of REGIONAL_KEYWORDS) {
    regionalResults.push(
      await fetchRegionalByKeyword(item).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason })
      )
    );
    await new Promise((r) => setTimeout(r, 1000));
  }

  const all = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`${COLUMNS[i].name}: ${r.reason?.message || r.reason}`);
  });
  gdResults.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`${GD_COLUMNS[i].name}: ${r.reason?.message || r.reason}`);
  });
  regionalResults.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`区域-${REGIONAL_KEYWORDS[i].kw}: ${r.reason?.message || r.reason}`);
  });

  // 广东区域优惠核心 seed 始终并入（保证专题一定展示核心政策），并补有效期状态
  // 区域 seed 的核实状态：前海企税 15% 已确认延续至 2027 年底（财税〔2026〕3号），
  // 横琴/南沙企税 15% 及三地个税 15% 暂未查到延续文件 → 待核实（不猜）
  const REGIONAL_STATUS = {
    'seed-qh-cit15': { expiry: '2027-12-31', status: '生效中' },
    'seed-hq-cit15': { expiry: null, status: '待核实' },
    'seed-ns-cit15': { expiry: null, status: '待核实' },
    'seed-hq-iit15': { expiry: null, status: '待核实' },
    'seed-qh-iit15': { expiry: '2027-12-31', status: '生效中' },
    'seed-ns-iit15': { expiry: null, status: '待核实' },
  };
  all.push(...REGIONAL_SEED.map((p) => {
    const st = REGIONAL_STATUS[p.id];
    return withExpiry(st ? { ...p, ...st } : { ...p }, `${p.title} ${p.summary || ''}`, p.date);
  }));
  // 全国高频核心优惠 seed 始终并入（用户最关心、且不在「最新50条」抓取范围），并补有效期状态
  all.push(...SEED_POLICIES.map((p) => withExpiry({ ...p }, `${p.title} ${p.plain || ''}`, p.date)));

  const seen = new Map();
  const dedup = [];
  for (const p of all) {
    // 按发文字号去重（seed 与动态抓取的同一政策文号相同，id 不同）；无文号回退 id
    const key = p.docNo ? 'doc:' + p.docNo.replace(/\s+/g, '') : 'id:' + p.id;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, p); dedup.push(p); continue; }
    // 重复时 seed（人工校对，摘要/提示更全）优先覆盖动态抓取的
    if (!prev.id.startsWith('seed-') && p.id.startsWith('seed-')) {
      dedup[dedup.indexOf(prev)] = p;
      seen.set(key, p);
    }
  }
  dedup.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  // 有 title 就保留；原文链接缺失(官方库未收录)不再当成脏数据丢弃，前端会显示「无链接 + 提示」
  const clean = dedup.filter((p) => p.title && (p.url || p.docNo));

  // 字段瘦身：不传输前端用不到的字段；summary 并入 plain（plain 优先，避免两份摘要重复传输）
  const list = clean.map((p) => {
    if (!p.plain && p.summary) p.plain = p.summary;
    delete p.summary;
    delete p.industry;
    return p;
  });

  // 给动态抓取、尚无「一句话看懂」的优惠政策补摘要：
  // 最新 10 条实质优惠抓详情页正文首段（真摘要），其余用模板摘要兜底。
  // 原因：CF Worker 免费计划 CPU 约 10ms，批量抓 60+ 详情页会超 CPU 被中断；
  // 同时排除「文库/目录/第N批/办理进度」等技术性通知（摘要价值低，模板兜底即可）
  const TECH_NOISE = /文库|目录|第.{1,3}批|办理进度|打击骗取|进一步加大出口退税|落实落细|便民办税/;
  const needSummary = list
    .filter((p) => p.isPreference && !p.plain && p.url && !p.url.includes('/wzjd/'));
  // 实质优惠（非技术性通知）前 10 条抓正文真摘要，其余（含技术性通知）用模板摘要兜底
  const detailBatch = needSummary.filter((p) => !TECH_NOISE.test(p.title)).slice(0, 10);
  const templateBatch = needSummary.filter((p) => !detailBatch.includes(p));
  if (detailBatch.length) {
    const settled = await Promise.allSettled(detailBatch.map((p) => fetchSummary(p.url)));
    detailBatch.forEach((p, j) => {
      const v = settled[j];
      p.plain = v.status === 'fulfilled' && v.value ? v.value : templatePlain(p);
    });
  }
  for (const p of templateBatch) p.plain = templatePlain(p);

  // 补摘要后重算有效期：详情页正文常含「至 YYYY 年 MM 月 DD 日」等表述，
  // 而 status 在 parseRecord 时已按旧 plain（当时为空）算过，这里用新 plain 再提取一次
  for (const p of needSummary) {
    if (p.status === '未标注' && p.plain) {
      const j = judgeStatus(parseExpiry(`${p.title} ${p.plain}`, p.date));
      if (j.status !== '未标注') { p.expiry = j.expiry; p.status = j.status; }
    }
  }

  // 《增值税法》2026-01-01 施行后，此前制发的国内环节增值税优惠政策原则上停止执行
  // 对这类历史增值税文件打中性提示标记，避免用户误当现行有效规定
  for (const p of list) {
    if ((p.taxTypes || []).includes('增值税') && p.date && p.date < '2026-01-01' && p.status === '未标注') {
      p.vatPre2026 = true;
    }
  }
  const hasNational = list.some((p) => p.region === '全国');
  const hasGd = list.some((p) => p.region === '广东');
  const areas = [...new Set(list.filter((p) => p.area).map((p) => p.area))];
  return {
    items: list,
    total: list.length,
    preferenceCount: list.filter((p) => p.isPreference).length,
    gdCount: list.filter((p) => p.region === '广东').length,
    regionalCount: list.filter((p) => p.area).length,
    source: clean.length ? 'chinatax' : 'seed',
    regions: [hasNational && '全国', hasGd && '广东'].filter(Boolean),
    areas,
    updatedAt: new Date().toISOString(),
    errors,
    version: 'auto',
  };
}

// ===== KV 读写 =====
async function readKV(env) {
  try {
    return await env.POLICIES.get('policies', 'json');
  } catch {
    return null;
  }
}

async function writeKV(env, data) {
  try {
    await env.POLICIES.put('policies', JSON.stringify(data));
  } catch (e) {
    console.error('KV write failed:', e?.message || e);
  }
}

// 判断缓存是否仍新鲜（24 小时内）
function isFresh(data) {
  if (!data || !data.updatedAt) return false;
  return Date.now() - new Date(data.updatedAt).getTime() < CACHE_TTL_MS;
}

// ===== 新增政策标记（每天 cron 抓取时与上一次快照 diff）=====
// KV 里存一份 { 政策id: 首次见到的日期 }，每次抓取对比：
//  - 不在快照里的 → 记为今天首次见到 → isNew = true
//  - 首次运行（快照不存在）→ 全部记为已见，不标 NEW（避免第一次上线满屏 NEW）
//  - 超过 NEW_DAYS 天的自动不再是 NEW
async function applyNewFlags(env, data) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let seen = await env.POLICIES.get(SEEN_KEY, 'json');
    const firstRun = !seen;
    seen = seen || {};
    const cutoff = Date.now() - NEW_DAYS * 86400 * 1000;
    const cutoff30 = Date.now() - 30 * 86400 * 1000;
    let newCount = 0;
    for (const p of data.items || []) {
      const pub = Date.parse(p.date);
      const recentPub = Number.isFinite(pub) && pub >= cutoff30;
      if (!seen[p.id]) {
        // 首次运行：近 30 天发布过的新政策以「今天」入册（后续 7 天保持 NEW），
        // 老政策回填自身发布日期（永不误标新增）；之后的新政策一律记今天
        seen[p.id] = (firstRun && !recentPub) ? (p.date || '2000-01-01') : today;
      }
      const fs = Date.parse(seen[p.id]);
      // 首次运行没有历史快照：按发布日期兜底（近 30 天发布的算新增），避免上线首日全无 NEW
      p.isNew = Number.isFinite(fs) && fs >= cutoff;
      if (p.isNew) newCount++;
    }
    data.newCount = newCount;
    // 清理快照：只保留当前列表里还在的 id，避免无限膨胀
    const cur = new Set((data.items || []).map((p) => p.id));
    for (const k of Object.keys(seen)) if (!cur.has(k)) delete seen[k];
    await env.POLICIES.put(SEEN_KEY, JSON.stringify(seen));
  } catch (e) {
    console.error('applyNewFlags failed:', e?.message || e);
  }
  return data;
}

// 统一落库：先打新增标记，再写缓存
async function saveAll(env, data) {
  await applyNewFlags(env, data);
  await writeKV(env, data);
  return data;
}

// ===== Worker 入口 =====
export default {
  // cron 定时任务：每天抓取最新政策 → 写 KV（配合 wrangler.toml [triggers]）
  async scheduled(event, env, ctx) {
    const data = await fetchAll();
    await saveAll(env, data);
    console.log(`[scheduled] 更新完成：${data.total} 条，优惠 ${data.preferenceCount} 条，广东 ${data.gdCount} 条`);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 政策列表 API：读 KV 秒出；过期但有旧数据 → 先返旧数据 + 后台刷新（stale-while-revalidate）；完全无缓存才现场抓取
    if (url.pathname === '/api/policies') {
      const cached = await readKV(env);
      if (isFresh(cached)) return json(cached);
      if (cached) {
        ctx.waitUntil((async () => {
          try { const fresh = await fetchAll(); await saveAll(env, fresh); } catch (e) { console.error('bg refresh failed:', e?.message || e); }
        })());
        return json(cached);
      }
      const data = await fetchAll();
      ctx.waitUntil(saveAll(env, data));
      return json(data);
    }

    // 增值税新法衔接对照表（静态数据，无需抓取）
    if (url.pathname === '/api/vat-continuity') {
      return json({
        law: VAT_LAW,
        groups: VAT_GROUPS,
        items: withUrl(VAT_CONTINUITY),
        total: VAT_CONTINUITY.length,
        updatedAt: new Date().toISOString(),
      });
    }

    // 企业所得税「到期地图」（静态数据，无需抓取）
    if (url.pathname === '/api/cit-continuity') {
      return json({
        law: CIT_LAW,
        groups: CIT_GROUPS,
        items: citWithUrl(CIT_CONTINUITY),
        total: CIT_CONTINUITY.length,
        updatedAt: new Date().toISOString(),
      });
    }

    // 个人所得税「到期地图」（静态数据，无需抓取）
    if (url.pathname === '/api/iit-continuity') {
      return json({
        law: IIT_LAW,
        groups: IIT_GROUPS,
        items: iitWithUrl(IIT_CONTINUITY),
        total: IIT_CONTINUITY.length,
        updatedAt: new Date().toISOString(),
      });
    }

    // 手动刷新（强制重新抓取 → 写 KV）
    if (url.pathname === '/api/refresh') {
      const data = await fetchAll();
      await saveAll(env, data);
      return json({ ok: true, total: data.total, preferenceCount: data.preferenceCount, gdCount: data.gdCount, source: data.source, updatedAt: data.updatedAt, errors: data.errors });
    }

    // 其余请求交给静态资产（web/）
    return env.ASSETS.fetch(request);
  },
};
