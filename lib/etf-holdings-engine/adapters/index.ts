// Registry of all 17 confirmed-issuer official-source adapters. One shared canonical model, one shared
// storage/diff engine (see ../types, ../storage, ../diffEngine) — adapters only translate their official
// source into a CanonicalSnapshot, they own no schema, diff, ranking, UI, or scheduler logic of their own.
import type { OfficialPcfAdapter } from "../types.ts";
import { NomuraOfficialPcfAdapter } from "./nomura.ts";
import { UpamcOfficialPcfAdapter } from "./upamc.ts";
import { AllianzOfficialPcfAdapter } from "./allianz.ts";
import { TaishinOfficialPcfAdapter } from "./taishin.ts";
import { FubonOfficialPcfAdapter } from "./fubon.ts";
import { CtbcOfficialPcfAdapter } from "./ctbc.ts";
import { FhtOfficialPcfAdapter } from "./fht.ts";
import { CapitalOfficialPcfAdapter } from "./capital.ts";
import { AbOfficialPcfAdapter } from "./ab.ts";
import { JpmorganOfficialPcfAdapter } from "./jpmorgan.ts";
import { FirstOfficialPcfAdapter } from "./first.ts";
import { YuantaOfficialPcfAdapter } from "./yuanta.ts";
import { MegaOfficialPcfAdapter } from "./mega.ts";
import { CathayOfficialPcfAdapter } from "./cathay.ts";
import { KgiOfficialPcfAdapter } from "./kgi.ts";
import { SinoPacOfficialPcfAdapter } from "./sinopac.ts";
import { BlackRockOfficialPcfAdapter } from "./blackrock.ts";

/** Issuer identity keyword (as matched against the official TWSE/TPEx ISIN registry fund name) -> adapter. */
export const ADAPTERS_BY_ISSUER_KEYWORD: Record<string, OfficialPcfAdapter> = {
  "野村": NomuraOfficialPcfAdapter,
  "統一": UpamcOfficialPcfAdapter,
  "安聯": AllianzOfficialPcfAdapter,
  "台新": TaishinOfficialPcfAdapter,
  "富邦": FubonOfficialPcfAdapter,
  "中信": CtbcOfficialPcfAdapter,
  "復華": FhtOfficialPcfAdapter,
  "群益": CapitalOfficialPcfAdapter,
  "聯博": AbOfficialPcfAdapter,
  "摩根": JpmorganOfficialPcfAdapter,
  "第一金": FirstOfficialPcfAdapter,
  "元大": YuantaOfficialPcfAdapter,
  "兆豐": MegaOfficialPcfAdapter,
  "國泰": CathayOfficialPcfAdapter,
  "凱基": KgiOfficialPcfAdapter,
  "永豐": SinoPacOfficialPcfAdapter,
  "貝萊德": BlackRockOfficialPcfAdapter,
};

export const ALL_ADAPTERS: OfficialPcfAdapter[] = Object.values(ADAPTERS_BY_ISSUER_KEYWORD);
