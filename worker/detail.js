// 详情页正文抓取：小程序里不能直接打开外部网页（web-view 要求备案域名），
// 所以由 Worker 抓官方原文正文，转成纯文本段落返回，前端自己渲染。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_CHARS = 6000; // 正文最多返回 6000 字，够看关键条款

// 页面里的噪音文案（分享、二维码、页脚、相关链接等）
const NOISE =
  /分享到|扫一扫|打印本页|关闭窗口|相关政策|政策解读|上一篇|下一篇|返回顶部|主办单位|网站标识码|版权所有|京ICP备|网站地图|关于我们|联系我们|浏览次数|字体[:：]|【字体|无障碍|长者模式|登录|注册|首页|当前位置|索引号|主题分类|发文机关|成文日期|发文字号|有效性|废止日期|tax|返回列表|中国政府网/i;

// 只有两三个字的噪音行（页脚导航）
const SHORT_NOISE = /^(文件|附件|打印|关闭|上一篇|下一篇|返回|更多|首页|分享|收藏)$/;

function decode(s) {
  return s
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\u3000+/g, ' ')
    .replace(/[ \t\r]+/g, ' ')
    .trim();
}

// 从 HTML 里抽出正文段落
export function extractBody(html) {
  let h = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // 优先找正文容器：总局 fgk 是 div.arc_cont，广东局是 #zoomcon，其它站点再兜底
  const anchors = ['class="arc_cont"', 'id="zoomcon"', 'class="TRS_Editor"', 'id="zoom"', 'class="article"', 'class="content"'];
  let seg = null;
  for (const a of anchors) {
    const i = h.indexOf(a);
    if (i > -1) {
      // 从标签结束的 > 之后开始，避免把 class="arc_cont"> 本身带进正文
      const gt = h.indexOf('>', i);
      seg = h.slice(gt > -1 ? gt + 1 : i);
      break;
    }
  }
  if (!seg) seg = h;

  // 截掉正文后面的分享/页脚区块
  const cut = seg.search(/<div[^>]*class="[^"]*(share|foot|footer|related|qrcode)/i);
  if (cut > 300) seg = seg.slice(0, cut);

  const raw = seg
    .split(/<\/p>|<br\s*\/?>|<\/div>|<\/h\d>/i)
    .map((t) => decode(t.replace(/<[^>]+>/g, ' ')))
    .map((t) => t.replace(/\s{2,}/g, ' ').trim())
    .filter((t) => t.length >= 2 && !NOISE.test(t) && !SHORT_NOISE.test(t) && !/^[\s·・\-—_=]+$/.test(t));

  // 合并成段落并控制总长度
  const out = [];
  let total = 0;
  for (const t of raw) {
    if (total + t.length > MAX_CHARS) {
      if (out.length === 0) out.push(t.slice(0, MAX_CHARS));
      break;
    }
    out.push(t);
    total += t.length;
  }
  return out;
}

// 抓一篇政策的正文
export async function fetchDetail(policy) {
  const url = policy?.url;
  if (!url) return { ok: false, error: 'no_url' };
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://fgk.chinatax.gov.cn/zcfgk/' },
    redirect: 'follow',
  });
  if (!res.ok) return { ok: false, error: 'http_' + res.status, url };
  const html = await res.text();
  const paragraphs = extractBody(html);
  if (!paragraphs.length) return { ok: false, error: 'empty', url };
  return {
    ok: true,
    url,
    title: policy.title,
    docNo: policy.docNo || '',
    date: policy.date || '',
    department: policy.department || '',
    paragraphs,
    chars: paragraphs.reduce((n, t) => n + t.length, 0),
  };
}
