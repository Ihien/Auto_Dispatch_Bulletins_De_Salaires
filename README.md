# Automatisation des bulletins de salaire (Google Apps Script)

Découpe le PDF de paie mensuel (une page par salarié) en bulletins individuels, les archive
dans `Racine / AAAA / MM` sur Google Drive et envoie chaque bulletin par courriel au salarié,
à partir de la table de correspondance Matricule / Email tenue dans Google Sheets.

Le traitement s'exécute entièrement dans le Google Workspace de l'entreprise : aucune donnée de
paie ne quitte Google. Seul le code des bibliothèques PDF est téléchargé (depuis jsDelivr), et
il est vérifié par empreinte SHA-256 avant d'être exécuté.

## Fonctionnement

```
Dossier source/Paie_Octobre.pdf (600 pages)
        │  pdf.js : lecture du texte de chaque page → regex « Matricule : XXX »
        │  Google Sheet : matricule → email
        │  pdf-lib : extraction de la page en PDF individuel
        ▼
Racine/2026/10/Bulletin_EMP001.pdf ──► courriel à l'employé (bulletin en pièce jointe)
Racine/2026/10/Anomalies/Alerte_Matricule_Inconnu_Page_17.pdf   (aucun envoi)
Racine/2026/10/Journal_Envois_2026_10_<id>                      (1 ligne par page)
Dossier source/_Traites/Paie_Octobre.pdf                        (en fin de traitement)
```

Google limite une exécution à 6 minutes. Le script s'arrête de lui-même après 5 minutes,
mémorise la page suivante et programme sa reprise une minute plus tard, jusqu'à la dernière
page. Il n'y a rien à faire entre le lancement et le rapport final, envoyé par courriel.

## Correspondance avec le BRD / FSD

| Exigence | Mise en œuvre |
|---|---|
| Règle 1 : une page par fichier | `extrairePage_` (`src/Pdf.gs`) copie une seule page dans un nouveau document |
| Règle 2 : `Bulletin_[Matricule].pdf` | `nomBulletin_` (`src/Archivage.gs`) |
| Règle 3 : `Racine/AAAA/MM` créé à la volée | `preparerArborescence_`, recherche par nom, aucun ID mensuel en dur |
| Règle 4 : matricule inconnu ou email manquant | `Alerte_Matricule_Inconnu_Page_[N].pdf` dans `AAAA/MM/Anomalies`, pas d'envoi, alerte dans les journaux |
| Règle 5 : quota de 1 500 courriels par jour | `MailApp.getRemainingDailyQuota()` vérifié avant chaque envoi |
| Critère : bulletins + anomalies = pages | Contrôle « CONFORME / NON CONFORME » dans le rapport final |
| Critère : aucune intervention humaine | Reprises automatiques par déclencheur, rapport final par courriel |
| Module 1 : lots et reprise | `src/Etat.gs`, état sauvegardé après **chaque** page (pas de double envoi à la reprise) |
| Module 2 : regex insensible à la casse | `REGEX_MATRICULE`, modifiable sans toucher au code |
| Cas limite : quota épuisé | Suspension, reprise le lendemain à 01:00, puis toutes les 2 h si besoin |
| Cas limite : matricule en double | Les deux bulletins sont archivés (IDs Drive distincts) et envoyés à la même adresse |

### Ajouts par rapport au document

- **`web-streams-polyfill`** : pdf.js a besoin de `ReadableStream`, absent du moteur Apps Script.
  Il est chargé depuis jsDelivr comme les deux autres bibliothèques. Les versions sont figées
  (pdf.js 2.16.105 *legacy*, pdf-lib 1.17.1) et leurs empreintes vérifiées.
- **Un seul PDF accepté dans le dossier source.** S'il y en a plusieurs, le lancement est refusé,
  pour ne jamais envoyer la mauvaise paie. Une fois traité, le PDF est déplacé dans `_Traites`.
- **Journal d'audit** (Google Sheet dans le dossier du mois) : page, matricule, statut
  (`ENVOYE`, `ANOMALIE`, `ECHEC_ENVOI`, `ERREUR`), fichier, destinataire, motif.
- **Échec d'envoi isolé** (adresse refusée par Gmail, par exemple) : le bulletin reste archivé,
  le cas est signalé dans le journal et le rapport, et le traitement continue.
- **Matricule présent deux fois dans la table avec deux emails différents** : l'envoi est bloqué
  pour ce matricule (anomalie) plutôt que de choisir une adresse au hasard.
- **Erreur bloquante** (CDN injoignable, Drive indisponible…) : 2 nouvelles tentatives à
  5 minutes d'intervalle, puis arrêt et courriel d'alerte à l'administrateur.
- **Mode test** (`EMAIL_REDIRECTION`) et **contrôle à blanc** (`verifierConfiguration`).
- La période d'archivage est figée au lancement : un traitement à cheval sur deux mois reste
  dans un seul dossier. On peut aussi l'imposer avec `PERIODE`.

## Installation

Prérequis : un compte Google Workspace (Business Standard ou Enterprise) ayant accès en écriture
aux dossiers Drive concernés et en lecture à la table de correspondance.

1. Ouvrir le Google Sheet de correspondance, puis *Extensions > Apps Script*. Le projet ainsi
   créé est rattaché au Sheet, ce qui permet d'afficher le menu « Bulletins de salaire ».
   (Un projet autonome créé sur <https://script.google.com> fonctionne aussi, mais sans menu :
   il faut alors renseigner `SHEET_CORRESPONDANCE_ID` et lancer les fonctions depuis l'éditeur.)
2. Copier les fichiers de `src/` dans le projet (même nom, extension `.gs`), puis remplacer le
   manifeste : *Paramètres du projet > Afficher le fichier manifeste « appsscript.json »*.

   Ou bien, avec [clasp](https://github.com/google/clasp) :
   ```bash
   npm install -g @google/clasp && clasp login
   cp .clasp.json.example .clasp.json   # scriptId : Paramètres du projet > ID du script
   clasp push
   ```
3. *Paramètres du projet > Propriétés du script* : renseigner au minimum les identifiants
   obligatoires ci-dessous. L'identifiant d'un dossier ou d'un classeur est la partie de son URL après
   `/folders/` ou `/d/`.

| Propriété | Obligatoire | Défaut | Rôle |
|---|---|---|---|
| `DOSSIER_SOURCE_ID` | oui | | Dossier où déposer le PDF maître |
| `DOSSIER_RACINE_ID` | oui | | Racine de l'archivage `AAAA/MM` |
| `SHEET_CORRESPONDANCE_ID` | si projet autonome | Sheet hôte | Google Sheet Matricule / Email |
| `ONGLET_CORRESPONDANCE` | | 1er onglet | Nom de l'onglet |
| `COLONNE_MATRICULE` / `COLONNE_EMAIL` | | `1` / `2` | Colonnes (1 = A) |
| `LIGNE_EN_TETE` | | `true` | Ignorer la première ligne |
| `REGEX_MATRICULE` | | `Matricule\s*:\s*(\w+)` | Expression de capture (groupe 1) |
| `PERIODE` | | date du jour | Forcer `AAAA-MM` |
| `EXPEDITEUR_NOM` | | Service des Ressources Humaines | Nom affiché de l'expéditeur |
| `EMAIL_REPONSE` | | | Adresse de réponse (ex. `rh@…`) |
| `OBJET_EMAIL` / `CORPS_EMAIL` | | voir `src/Config.gs` | Modèles : `{matricule}` `{mois}` `{annee}` `{nomMois}` |
| `EMAIL_REDIRECTION` | | | **Mode test** : tous les envois vont à cette adresse |
| `EMAIL_RAPPORT` | | compte exécutant | Destinataire du rapport final et des alertes |
| `MAX_PAGES_PAR_LOT` | | `0` (illimité) | Limiter un lot (essai pilote) |
| `BUDGET_TEMPS_MS` | | `300000` | Durée d'un lot avant mise en pause |
| `CREER_JOURNAL` | | `true` | Créer le journal d'audit |
| `UTILISATEURS_AUTORISES` | | tous les éditeurs | Adresses autorisées à utiliser le menu, séparées par des virgules |

4. Recharger le Sheet : le menu **Bulletins de salaire** apparaît. Choisir *Vérifier la
   configuration* et accepter les autorisations demandées (première fois seulement).
   Ce contrôle n'écrit rien et n'envoie rien. Il affiche le nombre de matricules lus, le nombre
   de pages du PDF, le matricule reconnu sur les 3 premières pages et le quota restant.

## Exploitation mensuelle

1. Déposer le PDF de paie (et lui seul) dans le dossier source.
2. Recommandé le premier mois : renseigner `EMAIL_REDIRECTION` avec votre adresse et
   `MAX_PAGES_PAR_LOT=5`, lancer, vérifier les courriels reçus, puis *Abandonner le traitement
   en cours*, supprimer ces deux propriétés et les fichiers de test.
3. Menu *Bulletins de salaire > Lancer l'envoi des bulletins…*. Le contrôle à blanc s'exécute,
   puis un résumé (fichier, nombre de pages, matricules non routables, quota) demande
   confirmation. Après « Oui », le Sheet rend la main tout de suite : les lots tournent en
   arrière-plan et le Sheet peut être fermé. Compter environ 15 à 25 minutes pour 600 bulletins
   (les appels Drive et Gmail prennent environ 1 à 2 s par page).
4. Suivre l'avancement avec *Voir l'avancement*.
5. Lire le rapport final reçu par courriel, puis traiter les fichiers du dossier `Anomalies` et
   les lignes `ECHEC_ENVOI` du journal (corriger la table, puis envoyer à la main).

| Menu | Fonction équivalente (éditeur) | Effet |
|---|---|---|
| Vérifier la configuration | `verifierConfiguration` | Contrôle à blanc de l'installation |
| Lancer l'envoi des bulletins… | `lancerTraitement` | Démarre le traitement du PDF du dossier source |
| Voir l'avancement | `afficherEtat` | Progression en cours, ou dernier rapport |
| Abandonner le traitement en cours… | `reinitialiserTraitement` | Abandonne le traitement (les fichiers créés sont conservés) |
| | `traiterLot` | Reprise (appelée par les déclencheurs ; à lancer à la main après une alerte) |

**Les courriels partent du compte de la personne qui lance le traitement**, et les reprises
automatiques s'exécutent sous ce même compte. Ce compte doit donc disposer du quota Workspace et
rester actif jusqu'à la fin.

### Adapter la regex au modèle de bulletin

La regex s'applique au texte de la page reconstitué ligne par ligne, puis au texte brut si besoin.
Exemples :

- `Matricule\s*:\s*(\w+)` : `Matricule : 00123` (par défaut)
- `Matricule\s*(?:N°|No)?\s*:?\s*([A-Z]{2}\d{4})` : `Matricule N° BB0123`
- `Mle\s*:\s*(\d+)` : `Mle : 4521`

Vérifiez le résultat avec `verifierConfiguration` (aperçu des 3 premières pages).

## Sécurité et confidentialité

- Les bulletins, la table de correspondance et le journal restent dans le Drive de l'entreprise.
  Les courriels partent du compte exécutant via Gmail.
- Le script tourne sous le compte qui le lance. Utilisez un compte RH dédié et limitez le partage
  du dossier racine, en particulier du sous-dossier `Anomalies`.
- Tout éditeur du Sheet de correspondance voit le menu **et peut modifier le code** du projet
  rattaché. Limitez donc les droits d'édition du Sheet à l'équipe paie. `UTILISATEURS_AUTORISES`
  restreint en plus l'usage du menu : il évite une fausse manœuvre, mais ne protège pas d'un
  éditeur malveillant. Avec un compte hors du domaine, Google ne communique pas toujours
  l'adresse de l'utilisateur, et l'accès est alors refusé.
- Pas de déploiement en application web : le menu suffit et n'expose aucune URL.
- Les bibliothèques sont téléchargées depuis jsDelivr à chaque lot, puis exécutées seulement si
  leur empreinte SHA-256 correspond à celle figée dans `src/Config.gs`. Pour changer de version,
  mettez à jour l'URL et l'empreinte
  (`curl -s URL | openssl dgst -sha256 -binary | base64`).
- Portées OAuth demandées : Drive, Sheets (et menu), Gmail (envoi), requêtes externes (CDN),
  déclencheurs.

## Limites connues

- Le PDF doit contenir du texte : un PDF scanné (image) n'a pas de texte, et toutes les pages
  partiront en anomalie. Il faut alors exporter la paie en PDF natif depuis le logiciel de paie.
- Un PDF protégé par mot de passe est refusé (erreur bloquante puis alerte) : l'exporter sans
  protection, le dossier source restant à accès restreint.
- Un bulletin qui s'étale sur deux pages n'est pas géré : la Règle 1 suppose une page par salarié.
- Quotas Google Workspace : 1 500 destinataires par jour, et 6 h cumulées d'exécution par jour
  pour les déclencheurs, ce qui laisse une large marge.
- Les déclencheurs appartiennent au compte qui a lancé le traitement : ce compte doit rester
  actif jusqu'à la fin.

## Tests

Les tests exécutent le vrai code `src/*.gs` dans un bac à sable Node qui reproduit le moteur
Apps Script : contexte V8 vierge à chaque exécution, sans `setTimeout`, `URL` ni
`ReadableStream`, et services Drive, Sheets, Gmail, propriétés et déclencheurs simulés en mémoire.
Les bibliothèques sont les fichiers npm identiques à ceux du CDN, empreintes comprises.

```bash
npm install
npm test
```

Scénarios couverts : traitement en plusieurs lots avec anomalies, doublon et contrôle
d'intégrité ; quota épuisé puis reprise sans doublon ; échec d'envoi isolé ; budget de temps nul ;
mot « Matricule » fragmenté dans le PDF ; mode test ; bibliothèque altérée sur le CDN ;
garde-fous de lancement ; contrôle à blanc ; lecture de la table de correspondance ; menu
(installation, lancement confirmé ou refusé, avancement, abandon, contrôle d'accès, erreurs).

Les tests ne remplacent pas un essai réel dans Apps Script (étape 2 de l'exploitation), seul à
même de valider les autorisations et les temps de réponse de Drive et Gmail.
