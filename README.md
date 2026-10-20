# Kenlod

**Le drive collaboratif des associations** : fichiers, documents, tableurs et questionnaires partagés, modifiables à plusieurs en temps réel. Libre, sans publicité, hébergeable soi-même.

*Kenlodañ* : partager, en breton. Instance officielle : **[kenlod.fr](https://kenlod.fr)**.

## Fonctionnalités

- **Mon espace** : dossiers, import de fichiers et de dossiers entiers (glisser-déposer), aperçu (images, PDF, vidéo, audio, texte), renommer, déplacer, copier, favoris, récents, recherche (noms et contenu des documents), corbeille (30 jours).
- **Groupes de travail** : chaque groupe a son propre espace de fichiers et trois rôles (administrateur, éditeur, lecteur). On ajoute un membre par e-mail ou avec un lien d'invitation (14 jours), envoyé par e-mail si besoin. Le journal d'activité indique qui a fait quoi.
- **Partage** : avec une personne ou un groupe entier, en lecteur ou éditeur. Les droits d'un dossier s'appliquent à tout son contenu, et la boîte de partage affiche les accès hérités.
- **Liens publics** : consultation sans compte, avec mot de passe et date d'expiration en option, compteur de consultations, révocables à tout moment.
- **Documents** : traitement de texte (titres, polices, couleurs, surlignage, listes, liens, alignement), tableaux (fusion de cellules, colonnes redimensionnables), images (bouton, copier-coller ou glisser-déposer), export HTML/texte/PDF.
- **Tableurs** :
  - formules en français ou en anglais (`=SOMME(A1:A10)`, `MOYENNE`, `SI`, `NB.SI`, `SOMME.SI`, `ARRONDI`…) ;
  - liste des fonctions avec leur aide pendant la saisie, et références insérées en cliquant sur les cellules ;
  - menu clic droit : insérer ou supprimer des lignes et des colonnes (formules mises à jour), trier ;
  - formats €, % et décimales, première ligne figée, recherche ;
  - somme et moyenne de la sélection ;
  - copier-coller depuis Excel ou LibreOffice, export CSV.
- **Questionnaires** :
  - 10 types de questions ;
  - lien de réponse public, anonyme par défaut, ou réservé aux comptes avec une réponse par personne ;
  - date de clôture ;
  - résultats en graphiques, export CSV ou en tableur, alerte par e-mail.
- **Édition à plusieurs en temps réel** :
  - chaque frappe arrive chez les autres en quelques millisecondes ;
  - on voit le curseur, la sélection et le nom de chacun ;
  - les modifications simultanées fusionnent automatiquement (CRDT [Yjs](https://yjs.dev) sur WebSocket) ;
  - hors ligne, on continue d'écrire.
- **Comptes** : confirmation de l'adresse e-mail, mot de passe oublié, invitations par e-mail.

## Installer sa propre instance

### En local

```bash
npm install
npm run build      # éditeur de documents : produit public/vendor/collab.js
npm run dev        # http://localhost:3000
npm test           # tests (API, droits, collaboration, questionnaires, formules)
```

Requiert **Node.js ≥ 22.13**, pour `node:sqlite` : il n'y a pas de base de données à installer. Les données vont dans `./data`, ou dans `DATA_DIR`.

Le premier compte créé devient administrateur. Sans configuration d'envoi de mails, les e-mails (confirmation, invitations…) sont écrits dans `data/outbox/` et dans la console.

### En production

`deploy/setup.sh` installe tout sur un serveur **Ubuntu 24.04** neuf :
- Node.js, et Caddy pour le HTTPS automatique avec Let's Encrypt ;
- un service systemd isolé ;
- un pare-feu, et une sauvegarde quotidienne de la base.

```bash
npm run build
tar czf kenlod.tgz package.json package-lock.json server shared public deploy
scp kenlod.tgz deploy/setup.sh root@SERVEUR:/tmp/
ssh root@SERVEUR "bash /tmp/setup.sh mon-domaine.fr www.mon-domaine.fr"
```

Le premier domaine est le domaine principal, les autres y redirigent. Le même script sert aux mises à jour : il remplace le code dans `/opt/kenlod` sans toucher aux données dans `/var/lib/kenlod`. La configuration se fait dans `/etc/kenlod.env`.

| Variable | Défaut | Rôle |
|---|---|---|
| `APP_URL` | `http://localhost:PORT` | adresse publique, utilisée dans les liens des e-mails |
| `REGISTRATION` | `open` | `closed` ferme les inscriptions publiques |
| `USER_QUOTA_MB` / `GROUP_QUOTA_MB` | `5120` / `20480` | quota d'un espace personnel ou de groupe |
| `MAX_UPLOAD_MB` | `512` | taille maximale d'un fichier |
| `TRASH_DAYS` | `30` | durée de conservation dans la corbeille |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_PREFIX` | — | fichiers dans un bucket S3 privé (DigitalOcean Spaces, Scaleway, MinIO…). Sinon, les fichiers restent sur le disque. Les téléchargements passent toujours par l'application, qui vérifie les droits |
| `BREVO_API_KEY` | — | envoi des e-mails par l'API HTTP de Brevo (utile quand l'hébergeur bloque les ports SMTP) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | — / `587` | ou envoi par SMTP authentifié (`deploy/set-mail.sh` aide à le configurer) |
| `MAIL_FROM` | `Kenlod <contact@kenlod.fr>` | expéditeur des e-mails |
| `EMAIL_VERIFICATION` | `required` si l'envoi d'e-mails est configuré | les nouveaux comptes confirment leur adresse avant d'accéder à l'appli |

**Avant d'ouvrir votre instance au public**, remplacez les pages de `public/site/` (accueil, mentions légales, CGU, confidentialité) par les vôtres : elles décrivent l'instance kenlod.fr et son éditeur. Les photos de la page d'accueil (`public/img/site/`) ne sont pas dans le dépôt. Elles viennent d'Unsplash, sous la licence Unsplash : mettez les vôtres sous les mêmes noms, ou adaptez `public/site/accueil.html`.

## Architecture

- **Serveur** :
  - Node.js et Express 5, SQLite (`node:sqlite`), multer pour les envois de fichiers ;
  - stockage de fichiers local ou S3 (`server/storage.js`).
- **Navigateur** : JavaScript natif, en modules ES et sans framework.
  - L'éditeur de documents utilise [TipTap](https://tiptap.dev). Il est assemblé par esbuild depuis `client/collab.js`.
  - Le moteur de formules du tableur est maison (`public/js/formula.js`).
- **Temps réel** : `server/collab.js` implémente le protocole y-websocket, et le serveur reste maître des droits :
  - la connexion exige une session valide, la même origine et un accès à l'élément ;
  - les modifications d'un lecteur sont ignorées ;
  - le nom affiché sur chaque curseur est imposé par le serveur ;
  - les droits sont revérifiés toutes les 15 s.
- **Stockage des documents** : l'état Yjs est sauvegardé dans SQLite. Un instantané nettoyé sert à la recherche, à l'export et aux liens publics. Le schéma des documents (`shared/doc-schema.js`) est commun au navigateur et au serveur.

## Sécurité

- **Comptes** : mots de passe hachés avec scrypt, cookie de session `HttpOnly`, `Secure` et `SameSite=Lax`, jeton CSRF sur chaque modification, nombre de tentatives limité.
- **Droits** : vérifiés côté serveur à chaque requête. Un élément inaccessible répond « introuvable ».
- **Contenus** : les fichiers HTML et SVG importés ne sont jamais affichés dans le navigateur, le contenu des documents est nettoyé côté serveur, et une politique CSP stricte s'applique.
- **Liens envoyés par e-mail** : jetons aléatoires à usage unique, dont seule l'empreinte est stockée.

Vous avez trouvé une faille ? Lisez [SECURITY.md](SECURITY.md) avant d'ouvrir un ticket.

## Contribuer

Les contributions sont les bienvenues : rapports de bugs, idées, traductions (une version en breton de l'interface est prévue), code. Voir [CONTRIBUTING.md](CONTRIBUTING.md).

Pistes :
- commentaires dans les documents ;
- historique des versions ;
- téléchargement d'un dossier en ZIP ;
- suppression du compte en libre-service ;
- administration des comptes ;
- interface en breton.

## Licence

Kenlod est un logiciel libre, sous licence [GNU AGPL v3](LICENSE) ou toute version ultérieure. Vous pouvez l'utiliser, l'étudier, le modifier et l'héberger. Si vous proposez une version modifiée en ligne, vous devez en publier le code source sous la même licence.

Le nom « Kenlod » et le logo à l'hermine désignent l'instance officielle kenlod.fr. Une instance indépendante ou un fork doit porter un autre nom.

© 2026 Elouan Haquin et les contributeurs et contributrices de Kenlod.
