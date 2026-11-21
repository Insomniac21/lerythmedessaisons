import { assertWritable } from "../../../ecrire/generer.js";
import { encodeBase64 } from "./jpeg.js";

function encodePath(filePath) {
  return filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function createGitHubClient(env, fetchImpl = fetch) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "master";
  const api = (env.GITHUB_API || "https://api.github.com").replace(/\/$/, "");
  const token = String(env.GITHUB_TOKEN || "").trim();

  async function request(path, options = {}) {
    const response = await fetchImpl(`${api}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lerythmedessaisons-journal",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 300) };
      }
    }
    if (!response.ok) {
      const error = new Error(data?.message || `GitHub ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  return {
    async readText(filePath) {
      assertWritable(filePath);
      try {
        const data = await request(`/repos/${owner}/${repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`);
        if (!data || data.type !== "file" || typeof data.content !== "string") return null;
        const binary = atob(data.content.replace(/\n/g, ""));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    async commit({ message, files, deletes }) {
      for (const filePath of Object.keys(files)) assertWritable(filePath);
      for (const filePath of deletes || []) assertWritable(filePath);
      const refData = await request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      const parentSha = refData.object.sha;
      const parent = await request(`/repos/${owner}/${repo}/git/commits/${parentSha}`);
      const tree = [];
      for (const [filePath, file] of Object.entries(files)) {
        const blob = await request(`/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          body: JSON.stringify(file.bytes
            ? { content: encodeBase64(file.bytes), encoding: "base64" }
            : { content: file.text, encoding: "utf-8" }),
        });
        tree.push({ path: filePath, mode: "100644", type: "blob", sha: blob.sha });
      }
      for (const filePath of deletes || []) {
        tree.push({ path: filePath, mode: "100644", type: "blob", sha: null });
      }
      const nextTree = await request(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
      });
      const commit = await request(`/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: nextTree.sha, parents: [parentSha] }),
      });
      await request(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
    },
  };
}
