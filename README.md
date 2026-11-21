# Le Rythme des Saisons

Site statique de la fermette familiale **Le Rythme des Saisons**, près de Saint-Jean-sur-Richelieu (Québec).

On y présente les cailles japonaises et les cochons d’Inde, la chaîne YouTube, les produits de saison (œufs de caille frais, sur réservation) et le journal de Zackary.

Le site est publié avec GitHub Pages, branche `master`, dossier `/`, sur le domaine [lerythmedessaisons.ca](https://lerythmedessaisons.ca).

## Fichiers

- `index.html` — la page d’accueil
- `styles.css` — la mise en page
- `assets/` — images et icônes
- `cailles/` — les fiches des cailles
- `articles/` — le journal de Zackary (liste, articles, `journal.json`)
- `ecrire/` — la page où Zackary écrit
- `outils/worker/` — le petit service qui vérifie le mot secret et publie
- `favicon.ico` — icône du site
- `CNAME` — domaine personnalisé
- `.nojekyll` — publication sans traitement Jekyll

## Le journal de Zackary

Zackary écrit un titre, son histoire et, s’il veut, une photo, puis il appuie sur **Publier mon article**. Il n’a pas besoin de Markdown, de HTML ni de Git.

Le site reste statique. La publication passe par un petit service gratuit (Cloudflare Worker) :

- le mot secret est vérifié **sur le service**, jamais dans le JavaScript du site ;
- le service seul possède un jeton GitHub limité à ce dépôt ;
- il ne peut écrire que dans `articles/` et `assets/articles/` ;
- huit mauvais mots de suite bloquent l’adresse pendant trente minutes ;
- la photo est réduite dans le navigateur (les données cachées, comme l’endroit de la prise de vue, partent avec) et le service retire encore ces données avant d’enregistrer.

GitHub n’autorise pas de compte avant 13 ans. On ne crée donc pas de compte GitHub pour Zackary. Le mot secret, choisi par son père, est l’accès. Le père en a un autre, distinct.

Tant que `ecrire/config.js` a un `brokerUrl` vide, le bouton Publier n’est pas allumé.

### Installation, une seule fois

À faire sur l’ordinateur, dans un terminal, après avoir fusionné cette fonction sur `master`.

1. Créer un compte gratuit sur [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Aucune carte de crédit. Ne pas transférer le domaine : le site reste sur GitHub Pages.
2. Créer un jeton GitHub fin : [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
   - Nom : `Journal de Zackary`
   - Expiration : dans un an (le maximum). Noter la date pour le renouveler.
   - Resource owner : `Insomniac21`
   - Repository access : **Only select repositories** → `lerythmedessaisons`
   - Permissions → Repository permissions → **Contents : Read and write**
   - Aucune autre permission. Generate token, copier le `github_pat_…` (il ne s’affiche qu’une fois).
3. Dans le dépôt :

   ```bash
   cd outils/worker
   npx wrangler login
   npx wrangler kv namespace create SESSIONS
   ```

   Copier l’`id` affiché à la place de `00000000000000000000000000000000` dans `outils/worker/wrangler.toml`.
4. Enregistrer les secrets (le terminal les demande, ils ne s’affichent pas, et ils ne vont pas dans Git) :

   ```bash
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put AUTH_SECRET_ZACKARY
   npx wrangler secret put AUTH_SECRET_PARENT
   npx wrangler deploy
   ```

   Les deux mots secrets font au moins 10 caractères. Une phrase que Zackary retient, différente de celle du père. Pas le nom d’un animal du site, pas un mot du dictionnaire tout seul.
5. Le déploiement affiche une adresse `https://journal-zackary.<compte>.workers.dev`. La coller dans `ecrire/config.js` :

   ```js
   export const config = {
     brokerUrl: "https://journal-zackary.<compte>.workers.dev",
   };
   ```

   Committer ce fichier sur `master`. Une minute plus tard, la page [Écrire un article](https://lerythmedessaisons.ca/ecrire/) demande le mot secret.

Si `master` est protégée et refuse l’écriture directe, le jeton du père doit avoir le droit de pousser sur `master` : GitHub → Settings → Rules → Rulesets (ou Branches).

### Au quotidien, pour Zackary

1. Ouvrir le site, menu **Le journal**.
2. **Zackary : écrire un article**.
3. Écrire le mot secret, **Entrer**. Sur la tablette, le navigateur peut s’en souvenir.
4. Écrire le titre et l’histoire. La photo est facultative.
5. **Publier mon article**.
6. Attendre une minute ou deux, puis rouvrir le journal.

**Corriger** et **Retirer** sont sous le formulaire. **Sortir** oublie la connexion de cet onglet (le mot secret reste demandé la prochaine fois).

### Renouveler le jeton

Avant la date d’expiration : créer un nouveau jeton avec les mêmes droits, puis `npx wrangler secret put GITHUB_TOKEN` et coller le nouveau. Rien d’autre à changer.

### Essai sur l’ordinateur, sans rien publier

```bash
node outils/servir-demo.mjs
```

Ouvrir l’adresse affichée. Le mot secret de cet essai s’écrit dans le terminal. Rien n’est envoyé à GitHub.
