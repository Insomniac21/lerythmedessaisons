import { config } from "./config.js";

const TOKEN_KEY = "zackary-session";
const DRAFT_KEY = "zackary-brouillon";

const MESSAGES = {
  "mot-incorrect": "Ce n'est pas le bon mot. Réessaie.",
  "trop-dessais": "Trop d'essais. Attends une demi-heure, puis réessaie.",
  "pas-active": "La publication n'est pas encore allumée. Demande à Papa.",
  "non-autorise": "Il faut entrer le mot secret.",
  titre: "Écris un titre, pas trop long.",
  texte: "Écris ton histoire. Elle peut être longue, mais pas un roman.",
  photo: "Cette photo ne convient pas. Choisis un JPG ou un PNG.",
  "photo-lire": "Je n'arrive pas à lire cette photo. Choisis un JPG ou un PNG.",
  "photo-lourde": "Cette photo est trop lourde. Essaie une autre.",
  introuvable: "Cet article n'est plus là.",
  "trop-vite": "Tu as beaucoup publié. Fais une pause et réessaie plus tard.",
  github: "L'article n'a pas pu être enregistré. Réessaie, ou demande à Papa.",
  reseau: "Ça n'a pas marché. Vérifie la connexion et réessaie.",
  origine: "La publication n'est pas ouverte depuis cette adresse.",
};

const attente = document.getElementById("attente");
const panelSetup = document.getElementById("panel-setup");
const panelLogin = document.getElementById("panel-login");
const panelEditor = document.getElementById("panel-editor");
const panelSucces = document.getElementById("panel-succes");
const formLogin = document.getElementById("form-login");
const formArticle = document.getElementById("form-article");
const mot = document.getElementById("mot");
const voirMot = document.getElementById("voir-mot");
const messageLogin = document.getElementById("message-login");
const messageEditeur = document.getElementById("message-editeur");
const titre = document.getElementById("titre");
const texte = document.getElementById("texte");
const photo = document.getElementById("photo");
const apercu = document.getElementById("apercu-photo");
const enleverPhoto = document.getElementById("enlever-photo");
const photoDeja = document.getElementById("photo-deja");
const ligneRetirer = document.getElementById("ligne-retirer-photo");
const retirerPhoto = document.getElementById("retirer-photo");
const boutonPublier = document.getElementById("publier");
const liste = document.getElementById("mes-articles");
const aucun = document.getElementById("aucun-article");
const sortir = document.getElementById("sortir");
const lienArticle = document.getElementById("lien-article");
const succesTitre = document.getElementById("succes-titre");
const encore = document.getElementById("encore");

let imageBase64 = null;
let apercuUrl = null;
let editingSlug = null;
let photoDejaLa = false;

function messageFor(error) {
  return MESSAGES[error?.code] || MESSAGES[error?.message] || MESSAGES.reseau;
}

function showMessage(element, error) {
  element.textContent = messageFor(error);
  element.hidden = false;
}

function hideMessage(element) {
  element.hidden = true;
  element.textContent = "";
}

function show(panel) {
  for (const item of [panelSetup, panelLogin, panelEditor, panelSucces]) item.hidden = item !== panel;
  attente.hidden = true;
}

function brokerUrl() {
  const raw = (config.brokerUrl || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  const localPage = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const localBroker = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") return url.origin;
  if (localPage && localBroker && url.protocol === "http:") return url.origin;
  return "";
}

function token() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.json) headers["content-type"] = "application/json";
  if (token()) headers.authorization = `Bearer ${token()}`;
  let response;
  try {
    response = await fetch(`${brokerUrl()}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.json ? JSON.stringify(options.json) : undefined,
    });
  } catch {
    const error = new Error("reseau");
    error.code = "reseau";
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "github");
    error.code = data.error || "github";
    throw error;
  }
  return data;
}

function saveDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      title: titre.value,
      body: texte.value,
      imageBase64,
      editingSlug,
    }));
  } catch {
    // Le brouillon est un confort. S'il est trop gros, on continue sans.
  }
}

function clearDraft() {
  sessionStorage.removeItem(DRAFT_KEY);
}

function clearPhoto() {
  imageBase64 = null;
  photo.value = "";
  if (apercuUrl) URL.revokeObjectURL(apercuUrl);
  apercuUrl = null;
  apercu.hidden = true;
  apercu.removeAttribute("src");
  enleverPhoto.hidden = true;
}

function resetForm() {
  editingSlug = null;
  photoDejaLa = false;
  titre.value = "";
  texte.value = "";
  retirerPhoto.checked = false;
  photoDeja.hidden = true;
  ligneRetirer.hidden = true;
  clearPhoto();
  boutonPublier.textContent = "Publier mon article";
  hideMessage(messageEditeur);
}

function restoreDraft() {
  const raw = sessionStorage.getItem(DRAFT_KEY);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    titre.value = draft.title || "";
    texte.value = draft.body || "";
    editingSlug = draft.editingSlug || null;
    if (draft.imageBase64) {
      imageBase64 = draft.imageBase64;
      apercu.src = `data:image/jpeg;base64,${imageBase64}`;
      apercu.hidden = false;
      enleverPhoto.hidden = false;
    }
    if (editingSlug) boutonPublier.textContent = "Enregistrer les corrections";
  } catch {
    clearDraft();
  }
}

async function fileToJpegBase64(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    const error = new Error("photo-lire");
    error.code = "photo-lire";
    throw error;
  }
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  let quality = 0.82;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  while (blob && blob.size > 1_100_000 && quality > 0.5) {
    quality -= 0.12;
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }
  if (!blob || blob.size > 1_200_000) {
    const error = new Error("photo-lourde");
    error.code = "photo-lourde";
    throw error;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.length)));
  }
  return { base64: btoa(binary), blob };
}

function renderArticles(articles) {
  liste.replaceChildren();
  aucun.hidden = articles.length > 0;
  for (const article of articles) {
    const item = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = article.title;
    const date = document.createElement("time");
    date.dateTime = article.date;
    date.textContent = article.date;
    const actions = document.createElement("div");
    actions.className = "editor-row";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn btn-ghost btn-small";
    edit.textContent = "Corriger";
    edit.addEventListener("click", () => correct(article.slug));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-quiet btn-small";
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => removeArticle(article));
    actions.append(edit, remove);
    item.append(strong, date, actions);
    liste.append(item);
  }
}

async function loadArticles() {
  const data = await api("/api/journal");
  renderArticles(data.articles || []);
}

async function enterEditor() {
  hideMessage(messageLogin);
  show(panelEditor);
  try {
    await loadArticles();
  } catch (error) {
    if (error.code === "non-autorise") {
      sessionStorage.removeItem(TOKEN_KEY);
      show(panelLogin);
      showMessage(messageLogin, error);
      return;
    }
    showMessage(messageEditeur, error);
  }
  restoreDraft();
  titre.focus();
}

async function correct(slug) {
  hideMessage(messageEditeur);
  try {
    const article = await api(`/api/article?slug=${encodeURIComponent(slug)}`);
    resetForm();
    editingSlug = article.slug;
    titre.value = article.title;
    texte.value = article.body;
    photoDejaLa = article.hasImage;
    photoDeja.hidden = !article.hasImage;
    ligneRetirer.hidden = !article.hasImage;
    boutonPublier.textContent = "Enregistrer les corrections";
    saveDraft();
    titre.focus();
    panelEditor.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showMessage(messageEditeur, error);
  }
}

async function removeArticle(article) {
  if (!window.confirm(`Tu veux vraiment retirer « ${article.title} » ?`)) return;
  hideMessage(messageEditeur);
  try {
    await api("/api/delete", { method: "POST", json: { slug: article.slug } });
    if (editingSlug === article.slug) {
      resetForm();
      clearDraft();
    }
    await loadArticles();
  } catch (error) {
    showMessage(messageEditeur, error);
  }
}

voirMot.addEventListener("click", () => {
  const visible = mot.type === "text";
  mot.type = visible ? "password" : "text";
  voirMot.textContent = visible ? "Voir le mot" : "Cacher le mot";
});

formLogin.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage(messageLogin);
  const button = formLogin.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await api("/api/login", { method: "POST", json: { passphrase: mot.value } });
    sessionStorage.setItem(TOKEN_KEY, data.token);
    mot.value = "";
    await enterEditor();
  } catch (error) {
    showMessage(messageLogin, error);
  } finally {
    button.disabled = false;
  }
});

photo.addEventListener("change", async () => {
  hideMessage(messageEditeur);
  const file = photo.files && photo.files[0];
  if (!file) return;
  try {
    const converted = await fileToJpegBase64(file);
    imageBase64 = converted.base64;
    if (apercuUrl) URL.revokeObjectURL(apercuUrl);
    apercuUrl = URL.createObjectURL(converted.blob);
    apercu.src = apercuUrl;
    apercu.hidden = false;
    enleverPhoto.hidden = false;
    retirerPhoto.checked = false;
    saveDraft();
  } catch (error) {
    clearPhoto();
    showMessage(messageEditeur, error);
  }
});

enleverPhoto.addEventListener("click", () => {
  clearPhoto();
  saveDraft();
});

titre.addEventListener("input", saveDraft);
texte.addEventListener("input", saveDraft);

formArticle.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage(messageEditeur);
  boutonPublier.disabled = true;
  const previousLabel = boutonPublier.textContent;
  boutonPublier.textContent = "Je publie…";
  const payload = { title: titre.value, body: texte.value };
  if (editingSlug) payload.slug = editingSlug;
  if (imageBase64) payload.imageBase64 = imageBase64;
  else if (retirerPhoto.checked) payload.removeImage = true;
  try {
    const result = await api("/api/publish", { method: "POST", json: payload });
    clearDraft();
    resetForm();
    succesTitre.textContent = previousLabel.startsWith("Enregistrer") ? "C'est corrigé !" : "C'est publié !";
    lienArticle.href = `../articles/${result.slug}.html`;
    show(panelSucces);
    await loadArticles().catch(() => {});
  } catch (error) {
    if (error.code === "non-autorise") {
      sessionStorage.removeItem(TOKEN_KEY);
      show(panelLogin);
      showMessage(messageLogin, error);
      return;
    }
    showMessage(messageEditeur, error);
  } finally {
    boutonPublier.disabled = false;
    boutonPublier.textContent = editingSlug ? "Enregistrer les corrections" : "Publier mon article";
  }
});

sortir.addEventListener("click", async () => {
  if (token()) await api("/api/logout", { method: "POST", json: {} }).catch(() => {});
  sessionStorage.removeItem(TOKEN_KEY);
  resetForm();
  show(panelLogin);
  mot.focus();
});

encore.addEventListener("click", async () => {
  resetForm();
  show(panelEditor);
  try {
    await loadArticles();
  } catch (error) {
    showMessage(messageEditeur, error);
  }
  titre.focus();
});

const url = brokerUrl();
if (!url) {
  show(panelSetup);
} else if (token()) {
  enterEditor();
} else {
  show(panelLogin);
  mot.focus();
}
