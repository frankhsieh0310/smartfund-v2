const SAY_VERBS_LIST = ["said", "says", "say", "told", "adds", "add", "added", "wrote", "writes", "noted", "argued", "warned", "stated", "remarked", "explained", "commented", "testified", "announced"];
const NAME_TOKEN = "[A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){0,3}";
const reNameVerb = new RegExp(`(${NAME_TOKEN})\\s+(?:${SAY_VERBS_LIST.join("|")})\\b`, "g");
const hay = "Buffett interview\nWarren Buffett told CNBC, \"Cash is a bad long-term investment, but it lets you be aggressive when others are fearful.\"";
let m;
while ((m = reNameVerb.exec(hay))) console.log('match', m[0], m.index);
console.log('quote index', hay.indexOf('"'));
