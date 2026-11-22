import { ARTICLE_SLUG } from "../../../ecrire/generer.js";
import { decodeBase64, stripJpegMetadata } from "./jpeg.js";

const TITLE_MAX = 80;
const BODY_MAX = 8000;
const IMAGE_MAX = 1_200_000;

function fail(name) {
  const error = new Error(name);
  error.code = name;
  throw error;
}

export function cleanTitle(value) {
  if (typeof value !== "string") fail("titre");
  const title = value.trim();
  if (!title || title.length > TITLE_MAX || /[\u0000-\u001F]/.test(title)) fail("titre");
  return title;
}

export function cleanBody(value) {
  if (typeof value !== "string") fail("texte");
  const body = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!body || body.length > BODY_MAX || body.includes("\u0000")) fail("texte");
  return body;
}

export function validateSlug(value) {
  if (typeof value !== "string" || !ARTICLE_SLUG.test(value)) fail("slug");
  return value;
}

export function validateSection(value) {
  if (value == null || value === "") return null;
  if (value === "zackary" || value === "carnet") return value;
  fail("section");
}

export function validatePublish(input) {
  if (!input || typeof input !== "object") fail("json");
  const title = cleanTitle(input.title);
  const body = cleanBody(input.body);
  const removeImage = input.removeImage === true;
  const slug = input.slug == null || input.slug === "" ? null : validateSlug(input.slug);
  const section = validateSection(input.section);
  let imageBytes = null;
  if (input.imageBase64 != null && input.imageBase64 !== "") {
    if (typeof input.imageBase64 !== "string" || input.imageBase64.length > 2_000_000) fail("photo");
    try {
      imageBytes = stripJpegMetadata(decodeBase64(input.imageBase64));
    } catch (error) {
      if (error.code === "photo") throw error;
      fail("photo");
    }
    if (imageBytes.length < 20 || imageBytes.length > IMAGE_MAX) fail("photo");
  }
  return { title, body, removeImage, slug, section, imageBytes };
}
