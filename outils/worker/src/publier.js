import {
  ARTICLE_SLUG,
  assertWritable,
  excerpt,
  makeSlug,
  quebecDateParts,
  renderArticlePage,
  renderListPage,
  serializeArticleData,
  serializeJournal,
} from "../../../ecrire/generer.js";

function fail(name) {
  const error = new Error(name);
  error.code = name;
  throw error;
}

function commitMessage(kind, title) {
  const short = title.slice(0, 72);
  if (kind === "edit") return `Journal de Zackary : correction — ${short}`;
  if (kind === "delete") return `Journal de Zackary : retrait — ${short}`;
  return `Journal de Zackary : ${short}`;
}

async function readJournal(github) {
  const text = await github.readText("articles/journal.json");
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail("journal");
  }
  if (!data || !Array.isArray(data.articles)) fail("journal");
  for (const article of data.articles) {
    if (!article || typeof article.slug !== "string" || !ARTICLE_SLUG.test(article.slug)) fail("journal");
  }
  return data.articles;
}

function entryFrom(article) {
  return {
    slug: article.slug,
    title: article.title,
    date: article.date,
    publishedAt: article.publishedAt,
    excerpt: article.excerpt,
    image: article.image || null,
  };
}

function filesFor(articles, article) {
  const files = {
    [`articles/${article.slug}.html`]: { text: renderArticlePage(article) },
    [`articles/data/${article.slug}.json`]: { text: serializeArticleData(article) },
    "articles/journal.json": { text: serializeJournal(articles) },
    "articles/index.html": { text: renderListPage(articles) },
  };
  for (const filePath of Object.keys(files)) assertWritable(filePath);
  return files;
}

export async function publishArticle(github, input, now = new Date()) {
  const articles = await readJournal(github);
  const previous = input.slug ? articles.find((article) => article.slug === input.slug) : null;
  if (input.slug && !previous) fail("introuvable");

  let slug;
  let date;
  let publishedAt;
  if (previous) {
    slug = previous.slug;
    date = previous.date;
    publishedAt = previous.publishedAt;
  } else {
    const parts = quebecDateParts(now);
    date = parts.iso;
    publishedAt = now.toISOString();
    slug = makeSlug(input.title, date, articles.map((article) => article.slug));
    if (!ARTICLE_SLUG.test(slug)) fail("slug");
  }

  const previousImage = previous?.image || null;
  let image = previousImage;
  const deletes = [];
  if (input.imageBytes) {
    image = `assets/articles/${slug}.jpg`;
  } else if (input.removeImage) {
    image = null;
    if (previousImage) deletes.push(previousImage);
  }

  const article = {
    slug,
    title: input.title,
    body: input.body,
    date,
    publishedAt,
    excerpt: excerpt(input.body),
    image,
  };
  const nextArticles = [
    ...articles.filter((item) => item.slug !== slug).map(entryFrom),
    entryFrom(article),
  ];
  const files = filesFor(nextArticles, article);
  if (input.imageBytes) {
    assertWritable(image);
    files[image] = { bytes: input.imageBytes };
  }
  for (const filePath of deletes) assertWritable(filePath);
  await github.commit({
    message: commitMessage(previous ? "edit" : "create", input.title),
    files,
    deletes,
  });
  return { slug, url: `/articles/${slug}.html` };
}

export async function deleteArticle(github, slug) {
  const articles = await readJournal(github);
  const current = articles.find((article) => article.slug === slug);
  if (!current) fail("introuvable");
  const dataPath = `articles/data/${slug}.json`;
  let title = current.title;
  const raw = await github.readText(dataPath);
  if (raw) {
    try {
      title = JSON.parse(raw).title || title;
    } catch {
      title = current.title;
    }
  }
  const remaining = articles.filter((article) => article.slug !== slug).map(entryFrom);
  const deletes = [`articles/${slug}.html`, dataPath];
  if (current.image) deletes.push(current.image);
  for (const filePath of deletes) assertWritable(filePath);
  await github.commit({
    message: commitMessage("delete", title),
    files: {
      "articles/journal.json": { text: serializeJournal(remaining) },
      "articles/index.html": { text: renderListPage(remaining) },
    },
    deletes,
  });
}

export async function listArticles(github) {
  const articles = await readJournal(github);
  return [...articles].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

export async function readArticle(github, slug) {
  const articles = await readJournal(github);
  if (!articles.some((article) => article.slug === slug)) fail("introuvable");
  const raw = await github.readText(`articles/data/${slug}.json`);
  if (!raw) fail("introuvable");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail("journal");
  }
  return {
    slug,
    title: data.title,
    body: data.body,
    date: data.date,
    hasImage: Boolean(data.image),
  };
}
