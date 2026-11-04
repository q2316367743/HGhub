/** 站点根地址：正文里的相对路径要补全 */
const SITE = "https://huangguoai.com";

/** 把各种写法的图片地址补成绝对地址；占位符（data:）返回空串 */
function abs(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/^data:/i.test(s)) return "";
  if (s.startsWith("//")) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return `${SITE}${s}`;
  return `${SITE}/${s.replace(/^\.\//, "")}`;
}

/**
 * 正文图片改写成 `data-hg-src`：窗口不能直连外网图，
 * 由 ArticleBody 逐张调 core 下载 / 解密后写成 data URL。
 */
function prepareImages(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("img").forEach((img) => {
    // 懒加载图：真实地址常在 data-* 上，src 只是占位
    const raw =
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("src") ||
      "";
    const src = abs(raw);
    if (!src) {
      img.remove();
      return;
    }
    img.setAttribute("data-hg-src", src);
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    img.removeAttribute("data-src");
    img.removeAttribute("data-original");
    img.setAttribute("loading", "lazy");
  });
  // 正文链接补全，避免点开指向本地
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = (a.getAttribute("href") || "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    const full = abs(href);
    if (full) a.setAttribute("href", full);
  });
  return doc.body.innerHTML;
}

/** 极简白名单清洗：去脚本、去事件属性、去 javascript: 链接 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button").forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  return prepareImages(doc.body.innerHTML);
}
