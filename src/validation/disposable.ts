import { emailDomain } from "@/lib/email";

/**
 * Free disposable/throwaway-domain blocklist.
 *
 * Kept in-repo so there is no runtime dependency on a third-party service.
 * To refresh, pull a public list (e.g. disposable-email-domains on GitHub) and
 * regenerate this array; entries must be lowercase, bare domains.
 */
const DISPOSABLE_DOMAINS: readonly string[] = [
  "0-mail.com", "0clickemail.com", "10minutemail.com", "10minutemail.net",
  "20minutemail.com", "33mail.com", "3d-painting.com", "4warding.com",
  "60minutemail.com", "a-bc.net", "aaathats3as.com", "adobeccepdm.com",
  "airmail.cc", "anonbox.net", "anonymbox.com", "antichef.com", "antispam.de",
  "armyspy.com", "azmeil.tk", "beefmilk.com", "binkmail.com", "bio-muesli.net",
  "bobmail.info", "bofthew.com", "brefmail.com", "bsnow.net", "bugmenot.com",
  "bumpymail.com", "burnermail.io", "buymoreplays.com", "byom.de",
  "cachedot.net", "card.zp.ua", "casualdx.com", "chammy.info", "childsavetrust.org",
  "chogmail.com", "choicemail1.com", "clixser.com", "cmail.club", "cool.fr.nf",
  "correo.blogos.net", "cosmorph.com", "courriel.fr.nf", "courrieltemporaire.com",
  "crapmail.org", "cust.in", "cuvox.de", "dacoolest.com", "dandikmail.com",
  "dayrep.com", "dcemail.com", "deadaddress.com", "deadspam.com", "despam.it",
  "devnullmail.com", "dfgh.net", "digitalsanctuary.com", "discard.email",
  "discardmail.com", "discardmail.de", "disposableaddress.com",
  "disposableemailaddresses.com", "disposableinbox.com", "dispose.it",
  "dispostable.com", "dodgeit.com", "dodgit.com", "donemail.ru", "dontreg.com",
  "dontsendmespam.de", "drdrb.net", "dump-email.info", "dumpandjunk.com",
  "dumpyemail.com", "e4ward.com", "easytrashmail.com", "einrot.com",
  "email60.com", "emailias.com", "emailigo.de", "emailinfive.com",
  "emailmiser.com", "emailsensei.com", "emailtemporanea.net", "emailtemporar.ro",
  "emailthe.net", "emailtmp.com", "emailwarden.com", "emailx.at.hm",
  "emailxfer.com", "emeil.in", "emz.net", "enterto.com", "ephemail.net",
  "etranquil.com", "explodemail.com", "fakeinbox.com", "fakemailz.com",
  "fansworldwide.de", "fantasymail.de", "fastacura.com", "fatflap.com",
  "fdfdsfds.com", "filzmail.com", "fizmail.com", "fleckens.hu", "frapmail.com",
  "friendlymail.co.uk", "fuckingduh.com", "fudgerub.com", "fyii.de",
  "garliclife.com", "gehensiemirnichtaufdensack.de", "get1mail.com",
  "get2mail.fr", "getairmail.com", "getmails.eu", "getonemail.com", "girlsundertheinfluence.com",
  "gishpuppy.com", "gmial.com", "goemailgo.com", "gotmail.net", "gowikibooks.com",
  "grandmamail.com", "great-host.in", "greensloth.com", "grr.la",
  "guerillamail.biz", "guerillamail.com", "guerrillamail.biz", "guerrillamail.com",
  "guerrillamail.de", "guerrillamail.info", "guerrillamail.net",
  "guerrillamail.org", "guerrillamailblock.com", "h8s.org", "hacccc.com",
  "haltospam.com", "harakirimail.com", "hidemail.de", "hidzz.com",
  "hmamail.com", "hotpop.com", "huajiachem.cn", "hulapla.de", "ieatspam.eu",
  "ieh-mail.de", "ignoremail.com", "ihateyoualot.info", "iheartspam.org",
  "imails.info", "inbax.tk", "inbox.si", "inboxalias.com", "inboxclean.com",
  "incognitomail.com", "incognitomail.org", "insorg-mail.info", "ipoo.org",
  "irish2me.com", "iwi.net", "jetable.com", "jetable.fr.nf", "jetable.net",
  "jetable.org", "jnxjn.com", "jourrapide.com", "junk1e.com", "kasmail.com",
  "kaspop.com", "killmail.com", "killmail.net", "klassmaster.com", "klzlk.com",
  "koszmail.pl", "kurzepost.de", "lawlita.com", "letthemeatspam.com",
  "lhsdv.com", "lifebyfood.com", "link2mail.net", "litedrop.com", "loadby.us",
  "login-email.cf", "lookugly.com", "lortemail.dk", "lr78.com", "lroid.com",
  "maboard.com", "mail-filter.com", "mail-temporaire.fr", "mail.by",
  "mail4trash.com", "mailbidon.com", "mailblocks.com", "mailbucket.org",
  "mailcat.biz", "mailcatch.com", "maildrop.cc", "maileater.com",
  "mailexpire.com", "mailfa.tk", "mailforspam.com", "mailfreeonline.com",
  "mailguard.me", "mailin8r.com", "mailinater.com", "mailinator.com",
  "mailinator.net", "mailinator2.com", "mailincubator.com", "mailismagic.com",
  "mailme.lv", "mailmetrash.com", "mailmoat.com", "mailnator.com",
  "mailnesia.com", "mailnull.com", "mailorg.org", "mailpick.biz", "mailrock.biz",
  "mailscrap.com", "mailshell.com", "mailsiphon.com", "mailtemp.info",
  "mailtome.de", "mailtothis.com", "mailtrash.net", "mailtv.net", "mailzilla.com",
  "makemetheking.com", "manybrain.com", "mbx.cc", "mega.zik.dj", "meinspamschutz.de",
  "meltmail.com", "messagebeamer.de", "mierdamail.com", "mintemail.com",
  "moburl.com", "mohmal.com", "moncourrier.fr.nf", "monemail.fr.nf",
  "monmail.fr.nf", "msa.minsmail.com", "mt2009.com", "mt2014.com", "mycard.net.ua",
  "mycleaninbox.net", "mymail-in.net", "mypacks.net", "mypartyclip.de",
  "myphantomemail.com", "mysamp.de", "mytempemail.com", "mytempmail.com",
  "mytrashmail.com", "nabuma.com", "neomailbox.com", "nepwk.com", "nervmich.net",
  "nervtmich.net", "netmails.com", "netmails.net", "neverbox.com", "nice-4u.com",
  "nincsmail.hu", "nnh.com", "no-spam.ws", "noblepioneer.com", "nomail.pw",
  "nomail.xl.cx", "nomail2me.com", "nomorespamemails.com", "nospam.ze.tc",
  "nospam4.us", "nospamfor.us", "nospammail.net", "notmailinator.com",
  "nowhere.org", "nowmymail.com", "nurfuerspam.de", "nus.edu.sg", "objectmail.com",
  "obobbo.com", "odnorazovoe.ru", "oneoffemail.com", "onewaymail.com",
  "onlatedotcom.info", "online.ms", "opayq.com", "ordinaryamerican.net",
  "otherinbox.com", "ovpn.to", "owlpic.com", "pancakemail.com", "pcusers.otherinbox.com",
  "pjjkp.com", "plexolan.de", "poczta.onet.pl", "politikerclub.de", "poofy.org",
  "pookmail.com", "privacy.net", "privatemail.com", "proxymail.eu", "prtnx.com",
  "putthisinyourspamdatabase.com", "quickinbox.com", "rcpt.at", "reallymymail.com",
  "recode.me", "recursor.net", "regbypass.com", "rejectmail.com", "reliable-mail.com",
  "rhyta.com", "rmqkr.net", "royal.net", "rtrtr.com", "s0ny.net", "safe-mail.net",
  "safersignup.de", "safetymail.info", "safetypost.de", "sandelf.de", "saynotospams.com",
  "schafmail.de", "selfdestructingmail.com", "sendspamhere.com", "sharklasers.com",
  "shieldedmail.com", "shiftmail.com", "shitmail.me", "shortmail.net", "sibmail.com",
  "sinnlos-mail.de", "slapsfromlastnight.com", "slaskpost.se", "smashmail.de",
  "smellfear.com", "snakemail.com", "sneakemail.com", "sofimail.com", "sofort-mail.de",
  "sogetthis.com", "soodonims.com", "spam4.me", "spamavert.com", "spambob.com",
  "spambog.com", "spambog.de", "spambog.ru", "spambox.us", "spamcannon.com",
  "spamcero.com", "spamcon.org", "spamcorptastic.com", "spamcowboy.com",
  "spamday.com", "spamex.com", "spamfree24.com", "spamfree24.de", "spamfree24.org",
  "spamgoes.in", "spamgourmet.com", "spamherelots.com", "spamhereplease.com",
  "spamhole.com", "spamify.com", "spaml.de", "spammotel.com", "spamobox.com",
  "spamslicer.com", "spamspot.com", "spamthis.co.uk", "spamtroll.net",
  "speed.1s.fr", "spoofmail.de", "stuffmail.de", "super-auswahl.de",
  "supergreatmail.com", "supermailer.jp", "superrito.com", "superstachel.de",
  "suremail.info", "talkinator.com", "teewars.org", "teleworm.com", "teleworm.us",
  "temp-mail.org", "temp-mail.ru", "tempail.com", "tempe-mail.com", "tempemail.biz",
  "tempemail.com", "tempemail.net", "tempinbox.co.uk", "tempinbox.com",
  "tempmail.eu", "tempmail.it", "tempmail2.com", "tempmaildemo.com",
  "tempmailer.com", "tempmailer.de", "tempomail.fr", "temporaryemail.net",
  "temporaryforwarding.com", "temporaryinbox.com", "temporarymailaddress.com",
  "tempthe.net", "thanksnospam.info", "thankyou2010.com", "thisisnotmyrealemail.com",
  "throwam.com", "throwawayemailaddress.com", "tilien.com", "tmail.ws",
  "tmailinator.com", "toiea.com", "tradermail.info", "trash-amil.com",
  "trash-mail.at", "trash-mail.com", "trash-mail.de", "trash2009.com",
  "trashdevil.com", "trashemail.de", "trashmail.at", "trashmail.com",
  "trashmail.de", "trashmail.me", "trashmail.net", "trashmail.org", "trashymail.com",
  "trialmail.de", "trillianpro.com", "tryalert.com", "turual.com", "twinmail.de",
  "tyldd.com", "uggsrock.com", "umail.net", "upliftnow.com", "uplipht.com",
  "uroid.com", "us.af", "venompen.com", "veryrealemail.com", "viditag.com",
  "viralplays.com", "vpn.st", "vsimcard.com", "vubby.com", "wasteland.rfc822.org",
  "webemail.me", "weg-werf-email.de", "wegwerf-emails.de", "wegwerfadresse.de",
  "wegwerfemail.com", "wegwerfemail.de", "wegwerfmail.de", "wegwerfmail.net",
  "wegwerfmail.org", "wh4f.org", "whyspam.me", "willhackforfood.biz",
  "willselfdestruct.com", "winemaven.info", "wronghead.com", "wuzup.net",
  "wuzupmail.net", "www.e4ward.com", "www.mailinator.com", "wwwnew.eu",
  "xagloo.com", "xemaps.com", "xents.com", "xmaily.com", "xoxy.net", "yep.it",
  "yogamaven.com", "yopmail.com", "yopmail.fr", "yopmail.net", "yourdomain.com",
  "ypmail.webarnak.fr.eu.org", "yuurok.com", "zehnminuten.de", "zehnminutenmail.de",
  "zippymail.info", "zoemail.net", "zomg.info",
];

const DISPOSABLE_SET = new Set(DISPOSABLE_DOMAINS);

/** Extra domains supplied at runtime (env or DB) without editing this file. */
const EXTRA = new Set(
  (process.env.DISPOSABLE_DOMAINS_EXTRA ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
);

export function isDisposableDomainName(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  return DISPOSABLE_SET.has(d) || EXTRA.has(d);
}

export function isDisposableDomain(email: string): boolean {
  return isDisposableDomainName(emailDomain(email));
}

export const disposableDomainCount = DISPOSABLE_SET.size;
