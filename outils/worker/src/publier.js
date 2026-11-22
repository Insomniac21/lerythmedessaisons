import {
  ARTICLE_SLUG,
  assertWritable,
  excerpt,
  makeSlug,
  quebecDateParts,
  renderArticlePage,
  renderListPage,
  sectionProfile,
  serializeArticleData,
  serializeJournal,
} from "../../../ecrire/generer.js";

function fail(name) {
  const error = new Error(name);
  error.code = name;
  throw error;
}

function commitMessage(section, kind, title) {
  const short = title.slice(0, 72);
  if (kind === "edit") return `${section.commit} : correction — ${short}`;
  if (kind === "delete") return `${section.commit} : retrait — ${short}`;
  return `${section.commit} : ${short}`;
}

async function readJournal(github, section) {
  const text = await github.readText(`${section.dir}/journal.json`);
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

function filesFor(section, articles, article) {
  const files = {
    [`${section.dir}/${article.slug}.html`]: { text: renderArticlePage(article, section.id) },
    [`${section.dir}/data/${article.slug}.json`]: { text: serializeArticleData(article) },
    [`${section.dir}/journal.json`]: { text: serializeJournal(articles) },
    [`${section.dir}/index.html`]: { text: renderListPage(articles, section.id) },
  };
  for (const filePath of Object.keys(files)) assertWritable(filePath);
  return files;
}

export async function publishArticle(github, input, now = new Date(), sectionId = "zackary") {
  const section = sectionProfile(sectionId);
  const articles = await readJournal(github, section);
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
    image = `${section.assets}/${slug}.jpg`;
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
  const files = filesFor(section, nextArticles, article);
  if (input.imageBytes) {
    assertWritable(image);
    files[image] = { bytes: input.imageBytes };
  }
  for (const filePath of deletes) assertWritable(filePath);
  await github.commit({
    message: commitMessage(section, previous ? "edit" : "create", input.title),
    files,
    deletes,
  });
  return { slug, url: `/${section.dir}/${slug}.html`, section: section.id };
}

export async function deleteArticle(github, slug, sectionId = "zackary") {
  const section = sectionProfile(sectionId);
  const articles = await readJournal(github, section);
  const current = articles.find((article) => article.slug === slug);
  if (!current) fail("introuvable");
  const dataPath = `${section.dir}/data/${slug}.json`;
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
  const deletes = [`${section.dir}/${slug}.html`, dataPath];
  if (current.image) deletes.push(current.image);
  for (const filePath of deletes) assertWritable(filePath);
  await github.commit({
    message: commitMessage(section, "delete", title),
    files: {
      [`${section.dir}/journal.json`]: { text: serializeJournal(remaining) },
      [`${section.dir}/index.html`]: { text: renderListPage(remaining, section.id) },
    },
    deletes,
  });
}

export async function listArticles(github, sectionId = "zackary") {
  const articles = await readJournal(github, sectionProfile(sectionId));
  return [...articles].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

export async function readArticle(github, slug, sectionId = "zackary") {
  const section = sectionProfile(sectionId);
  const articles = await readJournal(github, section);
  if (!articles.some((article) => article.slug === slug)) fail("introuvable");
  const raw = await github.readText(`${section.dir}/data/${slug}.json`);
  if (!raw) fail("introuvable");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail("journal");
  }
  return {
    slug,
    section: section.id,
    title: data.title,
    body: data.body,
    date: data.date,
    hasImage: Boolean(data.image),
  };
}
