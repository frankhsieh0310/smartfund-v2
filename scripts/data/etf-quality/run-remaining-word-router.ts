import { routeRemainingEtfWordDepth } from "./remaining-word-router.ts";
routeRemainingEtfWordDepth().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; });
