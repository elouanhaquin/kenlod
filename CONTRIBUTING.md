# Contribuer à Kenlod

Merci de votre intérêt ! Trugarez !

## Signaler un bug ou proposer une idée

Ouvrez un ticket (*issue*) en décrivant :
- ce que vous avez fait ;
- ce qui s'est passé ;
- ce que vous attendiez.

Précisez aussi le navigateur utilisé. Pour une faille de sécurité, n'ouvrez pas de ticket public : voir [SECURITY.md](SECURITY.md).

## Proposer du code

1. Créez une branche à partir de `main`.
2. Installez le projet : `npm install && npm run build`, puis `npm run dev`.
3. Faites votre modification et ajoutez des tests dans `test/` quand c'est possible.
4. Vérifiez que `npm test` passe.
5. Ouvrez une *pull request* qui explique le pourquoi du changement.

Quelques principes du projet :
- **Les droits se vérifient côté serveur**, jamais seulement dans l'interface.
- **Pas de service tiers dans le navigateur** : pas de CDN, de police externe ni de traceur. Tout est servi par l'instance.
- **Peu de dépendances** : l'interface est écrite en JavaScript natif, sans framework. Ajoutez une bibliothèque seulement si elle apporte beaucoup.
- **Textes en français**, clairs et sans jargon : les utilisateurs sont des bénévoles d'associations.
- Suivez le style du code existant : 2 espaces, des points-virgules, des noms en anglais dans le code.

En contribuant, vous acceptez que votre contribution soit publiée sous la licence du projet (GNU AGPL v3 ou ultérieure).

## Traductions

Une interface en breton est prévue. Si vous souhaitez y participer, ouvrez un ticket pour qu'on s'organise.
