'use strict';
/**
 * Simulation en mémoire des services Google Apps Script utilisés par le
 * projet. Chaque exécution (lancement manuel ou déclencheur) tourne dans un
 * contexte V8 neuf, comme sur les serveurs Google : seul l'« environnement »
 * (Drive, propriétés, déclencheurs, boîte d'envoi) persiste entre deux.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const RACINE_PROJET = path.join(__dirname, '..');
const DOSSIER_SRC = path.join(RACINE_PROJET, 'src');

/** Les CDN ne sont pas joignables en test : on sert les fichiers npm identiques. */
const FICHIERS_CDN = {
  'https://cdn.jsdelivr.net/npm/web-streams-polyfill@3.3.3/dist/polyfill.min.js': 'web-streams-polyfill/dist/polyfill.min.js',
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js': 'pdf-lib/dist/pdf-lib.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/legacy/build/pdf.worker.min.js': 'pdfjs-dist/legacy/build/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/legacy/build/pdf.min.js': 'pdfjs-dist/legacy/build/pdf.min.js'
};

const versSignes = (octets) => Array.from(octets, (o) => (o > 127 ? o - 256 : o));
const versBuffer = (signes) => Buffer.from(Uint8Array.from(signes, (o) => o & 0xff));

function iterateur(elements) {
  let i = 0;
  return { hasNext: () => i < elements.length, next: () => elements[i++] };
}

class Blob {
  constructor(octets, type, nom) {
    this.octets = Buffer.from(octets);
    this.type = type;
    this.nom = nom;
  }
  getBytes() { return versSignes(this.octets); }
  getName() { return this.nom; }
  getContentType() { return this.type; }
}

function creerEnvironnement() {
  let compteurId = 0;
  const env = {
    elements: new Map(),
    proprietes: {},
    declencheurs: [],
    courriels: [],
    quota: 1500,
    echecsEnvoi: new Set(),
    classeurs: new Map(),
    journaux: [],
    surchargesCdn: {},
    classeurHoteId: null,
    utilisateurActif: 'admin.rh@entreprise.bf',
    menus: [],
    alertes: [],
    reponsesAlertes: [],
    nouvelId: (prefixe) => prefixe + '_' + (++compteurId)
  };

  class Dossier {
    constructor(nom, parent) {
      this.id = env.nouvelId('dossier');
      this.nom = nom;
      this.parent = parent || null;
      env.elements.set(this.id, this);
    }
    getId() { return this.id; }
    getName() { return this.nom; }
    enfants() { return [...env.elements.values()].filter((e) => e.parent === this && !e.corbeille); }
    sousDossiers() { return this.enfants().filter((e) => e instanceof Dossier); }
    fichiers() { return this.enfants().filter((e) => e instanceof Fichier); }
    getFoldersByName(nom) { return iterateur(this.sousDossiers().filter((d) => d.nom === nom)); }
    getFilesByType(type) { return iterateur(this.fichiers().filter((f) => f.type === type)); }
    createFolder(nom) { return new Dossier(nom, this); }
    createFile(blob) { return new Fichier(blob.getName(), blob.getContentType(), blob.octets, this); }
    sousDossier(...noms) {
      return noms.reduce((d, nom) => d && d.sousDossiers().find((s) => s.nom === nom), this);
    }
  }

  class Fichier {
    constructor(nom, type, octets, parent) {
      this.id = env.nouvelId('fichier');
      this.nom = nom;
      this.type = type;
      this.octets = Buffer.from(octets || []);
      this.parent = parent;
      this.corbeille = false;
      env.elements.set(this.id, this);
    }
    getId() { return this.id; }
    getName() { return this.nom; }
    getBlob() { return new Blob(this.octets, this.type, this.nom); }
    moveTo(dossier) { this.parent = dossier; return this; }
    setTrashed(valeur) { this.corbeille = valeur; return this; }
  }

  class Feuille {
    constructor(nom, valeurs) { this.nom = nom; this.valeurs = valeurs || []; }
    setName(nom) { this.nom = nom; return this; }
    setFrozenRows() { return this; }
    getLastRow() { return this.valeurs.length; }
    getDataRange() { return { getValues: () => this.valeurs.map((l) => l.slice()) }; }
    getRange(ligne, colonne, nbLignes, nbColonnes) {
      const feuille = this;
      return {
        setValues(valeurs) {
          if (valeurs.length !== nbLignes || valeurs.some((l) => l.length !== nbColonnes)) {
            throw new Error('Dimensions incohérentes');
          }
          valeurs.forEach((l, i) => { feuille.valeurs[ligne - 1 + i] = l.slice(); });
          return this;
        },
        setFontWeight() { return this; }
      };
    }
  }

  env.racineDrive = new Dossier('Mon Drive');
  env.Dossier = Dossier;
  env.Fichier = Fichier;

  env.creerClasseur = (nom, onglets) => {
    const fichier = new Fichier(nom, 'application/vnd.google-apps.spreadsheet', [], env.racineDrive);
    const classeur = {
      feuilles: Object.entries(onglets).map(([n, v]) => new Feuille(n, v)),
      getId: () => fichier.id,
      getSheets: () => classeur.feuilles,
      getSheetByName: (n) => classeur.feuilles.find((f) => f.nom === n) || null
    };
    env.classeurs.set(fichier.id, classeur);
    return classeur;
  };

  const getElement = (id, Type) => {
    const element = env.elements.get(id);
    if (!(element instanceof Type)) throw new Error('Élément Drive introuvable : ' + id);
    return element;
  };

  env.services = () => {
    const consigne = [];
    const journaliser = (niveau) => (...args) => consigne.push(niveau + ' ' + args.join(' '));
    const services = {
      console: { log: journaliser('INFO'), warn: journaliser('WARN'), error: journaliser('ERROR') },
      DriveApp: {
        getFolderById: (id) => getElement(id, Dossier),
        getFileById: (id) => getElement(id, Fichier)
      },
      SpreadsheetApp: {
        openById: (id) => {
          const classeur = env.classeurs.get(id);
          if (!classeur) throw new Error('Classeur introuvable : ' + id);
          return classeur;
        },
        getActiveSpreadsheet: () => (env.classeurHoteId ? env.classeurs.get(env.classeurHoteId) : null),
        getUi: () => ({
          Button: { OK: 'OK', YES: 'YES', NO: 'NO' },
          ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' },
          alert: (...args) => {
            const [titre, message] = args.length === 1 ? ['', args[0]] : args;
            env.alertes.push({ titre, message });
            return env.reponsesAlertes.length ? env.reponsesAlertes.shift() : 'OK';
          },
          createMenu: (nom) => {
            const menu = { nom, elements: [] };
            const constructeur = {
              addItem: (libelle, fonction) => { menu.elements.push({ libelle, fonction }); return constructeur; },
              addSeparator: () => { menu.elements.push(null); return constructeur; },
              addToUi: () => { env.menus.push(menu); }
            };
            return constructeur;
          }
        }),
        create: (nom) => {
          const classeur = env.creerClasseur(nom, { 'Feuille 1': [] });
          env.journaux.push(classeur);
          return classeur;
        }
      },
      GmailApp: {
        sendEmail: (destinataire, objet, corps, options) => {
          if (env.quota <= 0) throw new Error('Service invoked too many times for one day: email.');
          if (env.echecsEnvoi.has(destinataire)) throw new Error('Invalid email: ' + destinataire);
          env.quota--;
          env.courriels.push({ destinataire, objet, corps, options });
        }
      },
      MailApp: {
        getRemainingDailyQuota: () => env.quota,
        sendEmail: (destinataire, objet, corps) => {
          if (env.quota <= 0) throw new Error('Service invoked too many times for one day: email.');
          env.quota--;
          env.courriels.push({ destinataire, objet, corps, rapport: true });
        }
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (cle) => (cle in env.proprietes ? env.proprietes[cle] : null),
          setProperty: (cle, valeur) => { env.proprietes[cle] = String(valeur); },
          deleteProperty: (cle) => { delete env.proprietes[cle]; },
          getProperties: () => Object.assign({}, env.proprietes)
        })
      },
      ScriptApp: {
        getProjectTriggers: () => env.declencheurs.slice(),
        deleteTrigger: (d) => { env.declencheurs = env.declencheurs.filter((x) => x !== d); },
        newTrigger: (fonction) => ({
          timeBased: () => ({
            at: (date) => ({
              create: () => {
                const d = { fonction, date: new Date(date.getTime()), getHandlerFunction: () => fonction };
                env.declencheurs.push(d);
                return d;
              }
            })
          })
        })
      },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
      Session: {
        getScriptTimeZone: () => 'UTC',
        getEffectiveUser: () => ({ getEmail: () => 'admin.rh@entreprise.bf' }),
        getActiveUser: () => ({ getEmail: () => env.utilisateurActif })
      },
      UrlFetchApp: {
        fetch: (url) => {
          const chemin = FICHIERS_CDN[url];
          if (!chemin) return { getResponseCode: () => 404 };
          const contenu = env.surchargesCdn[url] || fs.readFileSync(require.resolve(chemin));
          return {
            getResponseCode: () => 200,
            getContent: () => versSignes(contenu),
            getContentText: () => contenu.toString('utf8')
          };
        }
      },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'sha256' },
        computeDigest: (algo, octets) => versSignes(crypto.createHash(algo).update(versBuffer(octets)).digest()),
        base64Encode: (octets) => versBuffer(octets).toString('base64'),
        newBlob: (octets, type, nom) => new Blob(versBuffer(octets), type, nom),
        formatDate: (date, fuseau, format) => {
          const iso = date.toISOString();
          return format.replace('yyyy', iso.slice(0, 4)).replace('MM', iso.slice(5, 7))
            .replace('dd', iso.slice(8, 10)).replace('HH', iso.slice(11, 13))
            .replace('mm', iso.slice(14, 16)).replace('ss', iso.slice(17, 19));
        }
      }
    };
    return { services, consigne };
  };

  /** Nouvelle exécution : contexte V8 vierge (pas de setTimeout, URL, etc.). */
  env.executer = async (fonction) => {
    const { services, consigne } = env.services();
    const contexte = vm.createContext(services);
    vm.runInContext('delete globalThis.WebAssembly;', contexte);
    const sources = fs.readdirSync(DOSSIER_SRC).filter((f) => f.endsWith('.gs')).sort();
    for (const fichier of sources) {
      vm.runInContext(fs.readFileSync(path.join(DOSSIER_SRC, fichier), 'utf8'), contexte, { filename: fichier });
    }
    let erreur = null;
    let resultat;
    try {
      resultat = await contexte[fonction]();
    } catch (e) {
      erreur = e;
    }
    return { resultat, erreur, consigne, contexte };
  };

  /** Exécute les déclencheurs de reprise jusqu'à épuisement (ou limite). */
  env.executerDeclencheurs = async (limite = 100) => {
    let executions = 0;
    while (env.declencheurs.length && executions < limite) {
      const prochain = env.declencheurs.shift();
      const r = await env.executer(prochain.fonction);
      if (r.erreur) throw r.erreur;
      executions++;
    }
    return executions;
  };

  return env;
}

module.exports = { creerEnvironnement, versBuffer };
