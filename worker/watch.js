// 待跟踪政策清单（P8）
//
// 背景：横琴、南沙的企业所得税 15% 和港澳居民个税 15% 优惠，
// 原文件执行到 2025-12-31。财政部/税务总局给前海发了延续文件（财税〔2026〕3号），
// 但横琴、南沙的延续文件到目前（2026-11）在总局法规库、财政部、广东省税务局、
// 横琴/南沙专区四个渠道都检索不到。
//
// 这件事没法自动解决：官方没发文，任何"已延续"的说法都是猜的。
// 所以这里把它变成一张**可核对的清单**——写明等什么文件、去哪儿查、查到后改哪里，
// 避免时间一长没人记得这几条还挂着。

export const WATCH_ITEMS = [
  {
    id: 'watch-hq-cit15',
    name: '横琴粤澳深度合作区 企业所得税 15%',
    area: '横琴',
    tax: '企业所得税',
    expect: '财政部、税务总局关于延续横琴粤澳深度合作区企业所得税优惠政策的通知',
    basis: '财税〔2022〕19号（执行至 2025-12-31）',
    status: '待核实',
    waiting: '等财政部/税务总局发延续文件',
    howToCheck: '在总局法规库按「横琴 企业所得税」检索，或看广东省税务局横琴专区公告',
    fixAt: 'worker/index.js 的 REGIONAL_STATUS → seed-hq-cit15；确认后填 expiry 与文件链接',
  },
  {
    id: 'watch-hq-iit15',
    name: '横琴粤澳深度合作区 港澳居民个人所得税 15%',
    area: '横琴',
    tax: '个人所得税',
    expect: '财政部、税务总局关于延续横琴粤澳深度合作区个人所得税优惠政策的通知',
    basis: '财税〔2022〕3号（执行至 2025-12-31）',
    status: '待核实',
    waiting: '等财政部/税务总局发延续文件',
    howToCheck: '在总局法规库按「横琴 个人所得税」检索，或咨询 12366 横琴专线',
    fixAt: 'worker/iitContinuity.js 的横琴条目 + worker/index.js 的 REGIONAL_STATUS → seed-hq-iit15',
  },
  {
    id: 'watch-ns-cit15',
    name: '广州南沙 企业所得税 15%',
    area: '南沙',
    tax: '企业所得税',
    expect: '财政部、税务总局关于延续广州南沙企业所得税优惠政策的通知',
    basis: '财税〔2022〕40号（执行至 2025-12-31）',
    status: '待核实',
    waiting: '等财政部/税务总局发延续文件',
    howToCheck: '在总局法规库按「南沙 企业所得税」检索，或看广东省税务局南沙专区',
    fixAt: 'worker/index.js 的 REGIONAL_STATUS → seed-ns-cit15',
  },
  {
    id: 'watch-ns-iit15',
    name: '广州南沙 港澳居民个人所得税 15%',
    area: '南沙',
    tax: '个人所得税',
    expect: '财政部、税务总局关于延续广州南沙个人所得税优惠政策的通知',
    basis: '财税〔2022〕29号（执行至 2025-12-31）',
    status: '待核实',
    waiting: '等财政部/税务总局发延续文件',
    howToCheck: '在总局法规库按「南沙 个人所得税」检索，或咨询 12366',
    fixAt: 'worker/iitContinuity.js 的南沙条目 + worker/index.js 的 REGIONAL_STATUS → seed-ns-iit15',
  },
];

// 已确认延续的对照组，让清单不至于只有坏消息
export const WATCH_RESOLVED = [
  {
    id: 'resolved-qh-cit15',
    name: '前海深港现代服务业合作区 企业所得税 15%',
    area: '前海',
    status: '已延续',
    until: '2027-12-31',
    basis: '财税〔2026〕3号',
    url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5247000/content.html',
    note: '深圳税务局 12366 问答亦已确认延续',
  },
  {
    id: 'resolved-gba-iit',
    name: '粤港澳大湾区 境外高端人才个人所得税 15% 补贴',
    area: '大湾区',
    status: '已延续',
    until: '2027-12-31',
    basis: '财税〔2023〕34号',
    url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211530/content.html',
    note: '覆盖珠三角九市，含横琴/南沙所在片区的人才补贴口径',
  },
];

// 把清单和「当前政策库里有没有出现对应的新文件」对一下。
// 只要标题里同时出现地区名和「延续/延长」就认为可能有新文件，交给人工确认。
export function checkWatch(items) {
  const list = items || [];
  return WATCH_ITEMS.map((w) => {
    const areaKey = w.area;
    const hit = list.find((p) => {
      const t = p.title || '';
      return t.includes(areaKey) && /延续|延长|继续实施/.test(t) && !/废止|取消/.test(t);
    });
    return {
      ...w,
      found: hit ? { id: hit.id, title: hit.title, docNo: hit.docNo || '', url: hit.url || '' } : null,
      hint: hit
        ? '疑似发现延续文件，请人工确认后更新清单'
        : '政策库中暂未发现延续文件',
    };
  });
}

export function buildWatch(items) {
  return {
    pending: checkWatch(items),
    resolved: WATCH_RESOLVED,
    pendingCount: WATCH_ITEMS.length,
    note: '这几条的执行期到 2025-12-31，官方尚未发布延续文件。在发文前，实际能否享受请以主管税务机关口径为准。',
    updatedAt: new Date().toISOString(),
  };
}
