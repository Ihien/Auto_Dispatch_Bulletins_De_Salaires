'use strict';
process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const { creerEnvironnement } = require('./gas-mock');

const ANNUAIRE = [
  ['Matricule', 'Adresse Email'],
  ['EMP001', 'awa.ouedraogo@entreprise.bf'],
  ['emp002 ', 'boris.kabore@entreprise.bf'],
  ['EMP003', 'chantal.sawadogo@entreprise.bf'],
  ['EMP004', ''],
  ['EMP005', 'pas-un-email'],
  ['EMP006', 'daouda.traore@entreprise.bf'],
  ['EMP007', 'esther.zongo@entreprise.bf'],
  ['EMP008', 'fatou.compaore@entreprise.bf']
];

/** Construit un PDF maître : une page par entrée (null = page sans matricule). */
async function creerPdfMaitre(matricules, { fragmenter = false } = {}) {
  const doc = await PDFDocument.create();
  const police = await doc.embedFont(StandardFonts.Helvetica);
  matricules.forEach((matricule, i) => {
    const page = doc.addPage([595, 842]);
    page.drawText('BULLETIN DE PAIE - Octobre 2026', { x: 50, y: 790, size: 14, font: police });
    page.drawText('Page ' + (i + 1), { x: 50, y: 770, size: 9, font: police });
    if (matricule && fragmenter) {
      page.drawText('Matri', { x: 50, y: 740, size: 11, font: police });
      page.drawText('cule : ' + matricule, { x: 76, y: 740, size: 11, font: police });
    } else if (matricule) {
      page.drawText('Matricule : ' + matricule, { x: 50, y: 740, size: 11, font: police });
    }
    page.drawText('Salaire net a payer : ' + (150000 + i * 1000) + ' FCFA', { x: 50, y: 700, size: 11, font: police });
  });
  return Buffer.from(await doc.save());
}

async function textePdf(octets) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(octets), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const contenu = await (await doc.getPage(i)).getTextContent();
    pages.push(contenu.items.map((x) => x.str).join(' '));
  }
  return pages;
}

async function preparer(matricules, proprietes = {}, options = {}) {
  const env = creerEnvironnement();
  const source = env.racineDrive.createFolder('Paie - Dépôt');
  const racine = env.racineDrive.createFolder('Bulletins de salaire');
  const annuaire = env.creerClasseur('Correspondance', { Employes: ANNUAIRE });
  const pdf = await creerPdfMaitre(matricules, options);
  const maitre = new env.Fichier('Paie_Octobre_2026.pdf', 'application/pdf', pdf, source);
  Object.assign(env.proprietes, {
    DOSSIER_SOURCE_ID: source.getId(),
    DOSSIER_RACINE_ID: racine.getId(),
    SHEET_CORRESPONDANCE_ID: annuaire.getId(),
    PERIODE: '2026-10'
  }, proprietes);
  return { env, source, racine, maitre };
}

const bulletinsEnvoyes = (env) => env.courriels.filter((c) => !c.rapport);
const etat = (env) => (env.proprietes.ETAT_TRAITEMENT ? JSON.parse(env.proprietes.ETAT_TRAITEMENT) : null);

test('traitement complet en plusieurs lots avec anomalies, doublon et contrôle d\'intégrité', async () => {
  const pages = ['EMP001', 'EMP002', null, 'EMP999', 'EMP003', 'EMP004', 'EMP005', 'EMP006', 'EMP001', 'EMP007'];
  const { env, source, racine, maitre } = await preparer(pages, { MAX_PAGES_PAR_LOT: '3' });

  const lancement = await env.executer('lancerTraitement');
  assert.equal(lancement.erreur, null, lancement.consigne.join('\n'));
  assert.equal(etat(env).pageSuivante, 3);
  assert.equal(env.declencheurs.length, 1, 'un seul déclencheur de reprise');
  const reprises = await env.executerDeclencheurs();
  assert.equal(reprises, 3);

  const mois = racine.sousDossier('2026', '10');
  assert.ok(mois, 'arborescence Racine/2026/10 créée');
  const bulletins = mois.fichiers().filter((f) => f.type === 'application/pdf').map((f) => f.nom).sort();
  assert.deepEqual(bulletins, ['Bulletin_EMP001.pdf', 'Bulletin_EMP001.pdf', 'Bulletin_EMP002.pdf',
    'Bulletin_EMP003.pdf', 'Bulletin_EMP006.pdf', 'Bulletin_EMP007.pdf']);
  const anomalies = mois.sousDossier('Anomalies').fichiers().map((f) => f.nom).sort();
  assert.deepEqual(anomalies, ['Alerte_Matricule_Inconnu_Page_3.pdf', 'Alerte_Matricule_Inconnu_Page_4.pdf',
    'Alerte_Matricule_Inconnu_Page_6.pdf', 'Alerte_Matricule_Inconnu_Page_7.pdf']);
  assert.equal(bulletins.length + anomalies.length, pages.length, 'critère d\'acceptation');

  // Chaque courriel porte un PDF d'une seule page, celle de son destinataire.
  const envoyes = bulletinsEnvoyes(env);
  assert.equal(envoyes.length, 6);
  for (const courriel of envoyes) {
    const pieces = courriel.options.attachments;
    assert.equal(pieces.length, 1);
    const texte = await textePdf(pieces[0].octets);
    assert.equal(texte.length, 1, 'Règle 1 : une seule page');
    const matricule = /Matricule : (\w+)/.exec(texte[0])[1];
    assert.equal(pieces[0].getName(), 'Bulletin_' + matricule + '.pdf');
    const attendu = ANNUAIRE.find((l) => l[0].trim().toUpperCase() === matricule)[1];
    assert.equal(courriel.destinataire, attendu);
    assert.match(courriel.objet, /octobre 2026/);
    assert.equal(courriel.options.name, 'Service des Ressources Humaines');
  }
  assert.equal(envoyes.filter((c) => c.destinataire === 'awa.ouedraogo@entreprise.bf').length, 2,
    'doublon de matricule : deux bulletins envoyés à la même adresse');

  // Clôture : état purgé, déclencheurs supprimés, PDF maître classé, rapport envoyé.
  assert.equal(etat(env), null);
  assert.equal(env.declencheurs.length, 0);
  assert.equal(maitre.parent, source.sousDossier('_Traites'));
  const rapport = env.courriels.find((c) => c.rapport);
  assert.equal(rapport.destinataire, 'admin.rh@entreprise.bf');
  assert.match(rapport.corps, /CONFORME/);
  assert.doesNotMatch(rapport.corps, /NON CONFORME/);
  assert.match(rapport.objet, /4 cas à traiter/);

  // Journal d'audit : une ligne par page, rangé dans le dossier du mois.
  const journal = env.journaux[0];
  const lignes = journal.getSheets()[0].valeurs;
  assert.equal(lignes.length, pages.length + 1);
  assert.deepEqual(lignes.slice(1).map((l) => l[2]), pages.map((_, i) => i + 1));
  assert.deepEqual(lignes.slice(1).map((l) => l[4]), ['ENVOYE', 'ENVOYE', 'ANOMALIE', 'ANOMALIE', 'ENVOYE',
    'ANOMALIE', 'ANOMALIE', 'ENVOYE', 'ENVOYE', 'ENVOYE']);
  assert.match(lignes[3][8], /introuvable/);
  assert.match(lignes[4][8], /absent de la table/);
  assert.match(lignes[6][8], /Email manquant/);
  assert.equal(env.elements.get(journal.getId()).parent, mois);
});

test('quota épuisé : suspension, reprise le lendemain sans doublon', async () => {
  const pages = ['EMP001', 'EMP002', 'EMP003', 'EMP006', 'EMP007', 'EMP008'];
  const { env, racine } = await preparer(pages);
  env.quota = 4;

  await env.executer('lancerTraitement');
  const suspendu = etat(env);
  assert.equal(suspendu.statut, 'EN_ATTENTE_QUOTA');
  assert.equal(suspendu.pageSuivante, 4);
  assert.equal(env.declencheurs.length, 1);
  const reprise = env.declencheurs[0].date;
  const demain = new Date();
  demain.setDate(demain.getDate() + 1);
  assert.equal(reprise.toISOString().slice(0, 10), demain.toISOString().slice(0, 10));
  assert.equal(reprise.getHours(), 1);

  // Toujours pas de quota au réveil : nouvelle tentative deux heures plus tard.
  const avant = Date.now();
  await env.executerDeclencheurs(1);
  assert.equal(etat(env).pageSuivante, 4);
  assert.ok(env.declencheurs[0].date.getTime() - avant >= 2 * 3600 * 1000 - 1000);

  env.quota = 1500;
  await env.executerDeclencheurs();
  assert.equal(etat(env), null);
  assert.equal(bulletinsEnvoyes(env).length, 6);
  assert.equal(new Set(bulletinsEnvoyes(env).map((c) => c.destinataire)).size, 6);
  assert.equal(racine.sousDossier('2026', '10').fichiers().filter((f) => f.type === 'application/pdf').length, 6);
});

test('échec d\'envoi isolé : le bulletin reste archivé et le traitement continue', async () => {
  const { env } = await preparer(['EMP001', 'EMP002', 'EMP003']);
  env.echecsEnvoi.add('boris.kabore@entreprise.bf');
  await env.executer('lancerTraitement');
  assert.equal(etat(env), null);
  assert.equal(bulletinsEnvoyes(env).length, 2);
  const lignes = env.journaux[0].getSheets()[0].valeurs;
  assert.equal(lignes[2][4], 'ECHEC_ENVOI');
  const rapport = env.courriels.find((c) => c.rapport);
  assert.match(rapport.corps, /dont échecs envoi  : 1/);
  assert.match(rapport.corps, /CONFORME/);
});

test('budget de temps nul : une page par lot, progression garantie', async () => {
  const { env } = await preparer(['EMP001', 'EMP002', 'EMP003'], { BUDGET_TEMPS_MS: '0' });
  await env.executer('lancerTraitement');
  assert.equal(etat(env).pageSuivante, 1);
  assert.equal(await env.executerDeclencheurs(), 2);
  assert.equal(bulletinsEnvoyes(env).length, 3);
});

test('mot « Matricule » fragmenté dans le PDF : matricule tout de même reconnu', async () => {
  const { env } = await preparer(['EMP001', 'EMP002'], {}, { fragmenter: true });
  await env.executer('lancerTraitement');
  assert.deepEqual(bulletinsEnvoyes(env).map((c) => c.destinataire),
    ['awa.ouedraogo@entreprise.bf', 'boris.kabore@entreprise.bf']);
});

test('mode test : tous les courriels sont redirigés', async () => {
  const { env } = await preparer(['EMP001', 'EMP002'], { EMAIL_REDIRECTION: 'pilote@entreprise.bf' });
  await env.executer('lancerTraitement');
  const envoyes = bulletinsEnvoyes(env);
  assert.deepEqual(envoyes.map((c) => c.destinataire), ['pilote@entreprise.bf', 'pilote@entreprise.bf']);
  assert.match(envoyes[0].objet, /^\[TEST - destinataire réel : awa\.ouedraogo@entreprise\.bf\]/);
});

test('bibliothèque altérée sur le CDN : chargement refusé, nouvelle tentative puis arrêt', async () => {
  const { env } = await preparer(['EMP001']);
  env.surchargesCdn['https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'] = Buffer.from('alert(1)');
  const r = await env.executer('lancerTraitement');
  assert.equal(r.erreur, null);
  assert.ok(r.consigne.some((l) => /Empreinte SHA-256 inattendue pour pdf-lib/.test(l)));
  assert.equal(etat(env).echecsConsecutifs, 1);
  assert.equal(env.declencheurs.length, 1);
  await env.executerDeclencheurs();
  assert.equal(etat(env).statut, 'ECHEC');
  assert.equal(env.declencheurs.length, 0);
  assert.equal(bulletinsEnvoyes(env).length, 0);
  assert.match(env.courriels.find((c) => c.rapport).objet, /Traitement interrompu/);
});

test('garde-fous de lancement', async () => {
  const { env, source } = await preparer(['EMP001'], { MAX_PAGES_PAR_LOT: '1' });
  new env.Fichier('Autre.pdf', 'application/pdf', Buffer.from('%PDF'), source);
  let r = await env.executer('lancerTraitement');
  assert.match(r.erreur.message, /Plusieurs PDF/);

  const vide = creerEnvironnement();
  r = await vide.executer('lancerTraitement');
  assert.match(r.erreur.message, /DOSSIER_SOURCE_ID/);

  const deuxPages = await preparer(['EMP001', 'EMP002'], { MAX_PAGES_PAR_LOT: '1' });
  await deuxPages.env.executer('lancerTraitement');
  r = await deuxPages.env.executer('lancerTraitement');
  assert.match(r.erreur.message, /déjà en cours/);
  await deuxPages.env.executer('reinitialiserTraitement');
  assert.equal(etat(deuxPages.env), null);
  assert.equal(deuxPages.env.declencheurs.length, 0);
});

test('verifierConfiguration : contrôle à blanc sans écriture ni envoi', async () => {
  const { env, racine } = await preparer(['EMP001', 'EMP999', null]);
  const r = await env.executer('verifierConfiguration');
  assert.equal(r.erreur, null, r.consigne.join('\n'));
  assert.match(r.resultat, /8 matricules, dont 2 sans email valide/);
  assert.match(r.resultat, /3 pages/);
  assert.match(r.resultat, /page 1 → EMP001 \(email trouvé\) ; page 2 → EMP999 \(NON ROUTABLE\) ; page 3 → AUCUN MATRICULE/);
  assert.equal(env.courriels.length, 0);
  assert.equal(racine.sousDossiers().length, 0);
});

test('fonctions unitaires', async () => {
  const env = creerEnvironnement();
  env.proprietes.MAX_PAGES_PAR_LOT = '25';
  env.proprietes.LIGNE_EN_TETE = 'false';
  const { contexte: c } = await env.executer('afficherEtat');

  const config = c.lireConfig_();
  assert.equal(config.MAX_PAGES_PAR_LOT, 25);
  assert.equal(config.LIGNE_EN_TETE, false);
  assert.equal(config.BUDGET_TEMPS_MS, 300000);

  const regex = c.compilerRegexMatricule_(config.REGEX_MATRICULE);
  assert.equal(c.extraireMatricule_(['Nom : X  MATRICULE:  ab12 Service'], regex), 'AB12');
  assert.equal(c.extraireMatricule_(['Matri cule : Z9', 'Matricule : Z9'], regex), 'Z9');
  assert.equal(c.extraireMatricule_(['Aucun identifiant', 'Aucun identifiant'], regex), null);

  const fragment = (str, x, y, width) => ({ str, transform: [11, 0, 0, 11, x, y], width });
  assert.equal(c.reconstruireLignes_([
    fragment('Matri', 50, 740, 24.4), fragment(' ', 74.4, 740, 1.6), fragment('cule : EMP1', 76, 740, 60),
    fragment('Salaire', 50, 700, 40), fragment('net', 95, 700, 20)
  ]), 'Matricule : EMP1\nSalaire net');
  assert.throws(() => c.compilerRegexMatricule_('Matricule\\s*:\\s*\\w+'), /groupe de capture/);

  assert.equal(c.nomBulletin_('A/12 3'), 'Bulletin_A-12-3.pdf');
  assert.equal(c.nomAnomalie_(42), 'Alerte_Matricule_Inconnu_Page_42.pdf');
  assert.equal(c.remplirModele_('{nomMois} {annee} {inconnu}', { nomMois: 'août', annee: '2026' }), 'août 2026 {inconnu}');
  assert.deepEqual({ ...c.determinerPeriode_({ PERIODE: '' }, new Date('2027-01-31T23:00:00Z')) }, { annee: '2027', mois: '01' });

  const base = new Date('2026-10-22T14:30:00Z');
  assert.equal(c.dateRepriseQuota_({ HEURE_REPRISE_QUOTA: 1 }, base, false).toISOString(), '2026-10-23T01:00:00.000Z');
  assert.equal(c.dateRepriseQuota_({ HEURE_REPRISE_QUOTA: 1 }, base, true).toISOString(), '2026-10-22T16:30:00.000Z');

  assert.throws(() => c.validerConfig_(Object.assign({}, config, {
    DOSSIER_SOURCE_ID: 'a', DOSSIER_RACINE_ID: 'b', SHEET_CORRESPONDANCE_ID: 'c', PERIODE: '2026-13'
  })), /PERIODE/);
});

test('table de correspondance : en-tête, normalisation et doublons contradictoires', async () => {
  const env = creerEnvironnement();
  const classeur = env.creerClasseur('Correspondance', {
    Employes: [
      ['Matricule', 'Email'],
      [' a1 ', ' a1@ex.bf '],
      ['A2', 'a2@ex.bf'],
      ['A2', 'autre@ex.bf'],
      ['A3', 'a3@ex.bf'],
      ['A3', 'a3@ex.bf'],
      ['', 'orphelin@ex.bf'],
      [1234, 'num@ex.bf']
    ]
  });
  env.proprietes.SHEET_CORRESPONDANCE_ID = classeur.getId();
  const { contexte: c } = await env.executer('afficherEtat');
  const annuaire = c.chargerAnnuaire_(c.lireConfig_());
  assert.deepEqual({ ...annuaire }, { A1: 'a1@ex.bf', A2: '', A3: 'a3@ex.bf', 1234: 'num@ex.bf' });
});
