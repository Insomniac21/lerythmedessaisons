const ORIGIN = "https://lerythmedessaisons.ca";
const SLUG_SRC = "[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*";

export const ARTICLE_SLUG = new RegExp(`^${SLUG_SRC}$`);
export const WRITABLE_PATH = new RegExp(
  `^(?:articles\\/journal\\.json|articles\\/index\\.html|articles\\/${SLUG_SRC}\\.html|articles\\/data\\/${SLUG_SRC}\\.json|assets\\/articles\\/${SLUG_SRC}\\.jpg)$`
);

const FONT_HREF = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500&family=Nunito+Sans:wght@400;600;700&display=swap";

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function slugifyTitle(title) {
  return String(title)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function makeSlug(title, dateIso, existingSlugs) {
  const base = slugifyTitle(title) || "article";
  const slug = `${dateIso}-${base}`.replace(/-+$/g, "");
  if (!existingSlugs.includes(slug)) return slug;
  let n = 2;
  while (existingSlugs.includes(`${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

export function labelFromIso(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-CA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function quebecDateParts(date = new Date()) {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return { iso, label: labelFromIso(iso) };
}

export function excerpt(text, max = 140) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const base = (space > 40 ? cut.slice(0, space) : cut).trim();
  return `${base}…`;
}

export function paragraphBlocks(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.split("\n").map((line) => line.replace(/\s+$/g, "")).filter((line) => line.length > 0))
    .filter((lines) => lines.length > 0);
}

export function textToParagraphs(text) {
  return paragraphBlocks(text)
    .map((lines) => `<p>${lines.map((line) => escapeHtml(line)).join("<br>")}</p>`)
    .join("\n");
}

function page({ title, description, canonicalPath, imagePath, main }) {
  const canonical = `${ORIGIN}${canonicalPath}`;
  const image = imagePath
    ? `${ORIGIN}/${imagePath.replace(/^\//, "")}`
    : `${ORIGIN}/assets/og-image.jpg`;
  const imageSize = imagePath
    ? ""
    : `\n<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`;
  return `<!doctype html>
<html lang="fr-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:locale" content="fr_CA">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${escapeHtml(image)}">${imageSize}
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#7d9471">
<link rel="icon" href="../favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="../assets/favicon-32.png">
<link rel="apple-touch-icon" href="../assets/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONT_HREF}" rel="stylesheet">
<link rel="stylesheet" href="../styles.css">
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>

<header class="site-header">
  <div class="wrap nav-bar">
    <a class="brand" href="../index.html"><img src="../assets/logo-256.webp" alt="" width="44" height="44"><span>Le Rythme des Saisons</span></a>
    <button class="nav-toggle" aria-expanded="false" aria-controls="menu" aria-label="Ouvrir le menu"><span></span><span></span><span></span></button>
    <nav id="menu" aria-label="Navigation principale">
      <a href="../index.html#a-propos">À propos</a>
      <a href="../index.html#animaux">Nos animaux</a>
      <a href="../cailles/index.html">Nos cailles</a>
      <a href="index.html" aria-current="page">Le journal</a>
      <a href="../index.html#videos">Vidéos</a>
      <a href="../index.html#produits">Produits</a>
      <a href="../index.html#contact">Contact</a>
    </nav>
  </div>
</header>

<main id="contenu">
${main}
</main>

<footer class="site-footer">
  <div class="wrap">
    <img src="../assets/logo-256.webp" alt="" width="56" height="56" loading="lazy">
    <p>© 2026 Le Rythme des Saisons · <a href="https://www.youtube.com/@lerythmedessaisons" target="_blank" rel="noopener">YouTube</a></p>
  </div>
</footer>

<script>
  const t=document.querySelector('.nav-toggle'),m=document.getElementById('menu');
  t.addEventListener('click',()=>{const o=t.getAttribute('aria-expanded')==='true';t.setAttribute('aria-expanded',!o);m.classList.toggle('open',!o);});
  m.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{t.setAttribute('aria-expanded','false');m.classList.remove('open');}));
</script>
<script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "6b90ef3797f9465cb8a06733ff3b28a1"}'></script>
</body>
</html>
`;
}

export function renderArticlePage(article) {
  const description = excerpt(article.body) || article.title;
  const dateLabel = labelFromIso(article.date);
  const figure = article.image
    ? `
      <figure class="journal-photo">
        <img src="../${escapeHtml(article.image)}" alt="${escapeHtml(article.title)}">
      </figure>`
    : "";
  const main = `  <section class="section journal-page">
    <div class="wrap narrow">
      <p class="back-link"><a href="index.html">← Le journal de Zackary</a></p>
      <h1>${escapeHtml(article.title)}</h1>
      <p class="journal-byline">Écrit par Zackary · <time datetime="${escapeHtml(article.date)}">${escapeHtml(dateLabel)}</time></p>${figure}
      <div class="journal-body">
${textToParagraphs(article.body)}
      </div>
    </div>
  </section>`;
  return page({
    title: `${article.title} · Le journal de Zackary`,
    description,
    canonicalPath: `/articles/${article.slug}.html`,
    imagePath: article.image,
    main,
  });
}

export function renderListPage(articles) {
  const sorted = [...articles].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  const cards = sorted.length
    ? `      <div class="cards journal-cards">
${sorted.map((article) => {
  const image = article.image
    ? `\n            <img src="../${escapeHtml(article.image)}" alt="" loading="lazy">`
    : "";
  return `        <article class="card">
          <a class="card-hit" href="${escapeHtml(article.slug)}.html">${image}
            <div class="card-body">
              <p class="journal-date"><time datetime="${escapeHtml(article.date)}">${escapeHtml(labelFromIso(article.date))}</time></p>
              <h2 class="journal-card-title">${escapeHtml(article.title)}</h2>
              <p>${escapeHtml(article.excerpt || "")}</p>
              <span class="card-more">Lire l'article →</span>
            </div>
          </a>
        </article>`;
}).join("\n")}
      </div>`
    : `      <p class="journal-empty">Pas encore d'histoire ici. Zackary en écrira bientôt une.</p>`;
  const main = `  <section class="section journal-page">
    <div class="wrap narrow">
      <h1>Le journal de Zackary</h1>
      <p class="lead">Des petites histoires écrites par Zackary, au fil des saisons.</p>
      <p class="center">Les cailles, les cochons d'Inde, et les moments de la fermette.</p>
    </div>
    <div class="wrap">
${cards}
      <p class="center journal-write"><a class="btn btn-ghost" href="../ecrire/">Zackary : écrire un article</a></p>
    </div>
  </section>`;
  return page({
    title: "Le journal de Zackary · Le Rythme des Saisons",
    description: "Les articles de Zackary : des petites histoires de la fermette, au fil des saisons.",
    canonicalPath: "/articles/",
    imagePath: null,
    main,
  });
}

export function serializeJournal(articles) {
  const sorted = [...articles].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return `${JSON.stringify({ articles: sorted }, null, 2)}\n`;
}

export function serializeArticleData(article) {
  return `${JSON.stringify({
    title: article.title,
    body: article.body,
    date: article.date,
    publishedAt: article.publishedAt,
    image: article.image || null,
  }, null, 2)}\n`;
}

export function assertWritable(filePath) {
  if (!WRITABLE_PATH.test(filePath)) {
    const error = new Error("chemin");
    error.code = "chemin";
    throw error;
  }
}
