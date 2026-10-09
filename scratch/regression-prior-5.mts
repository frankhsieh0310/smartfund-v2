import { readFileSync } from 'node:fs';
import { attributePerson, type PersonRef } from '../lib/consensus/attribution';

const items = JSON.parse(readFileSync('scratch/attributed-items.json', 'utf8')) as Array<{
  idx: number; personSlug: string; person: string; personCountry: string | null; source: string; sourceGrade: string; title: string | null; url: string; text: string;
}>;
const peopleMap: Record<string, PersonRef> = {
  'jensen-huang': { id: 'p1', slug: 'jensen-huang', displayName: 'Jensen Huang', aliases: ['Jensen Huang', 'Jen-Hsun Huang'], country: 'US' },
  'donald-trump': { id: 'p5', slug: 'donald-trump', displayName: 'Donald Trump', aliases: ['President Trump'], country: 'US' },
};
const people = Object.values(peopleMap);
const sourceMeta: Record<string, { isOfficial: boolean; type: string }> = {
  'nvidia-newsroom': { isOfficial: true, type: 'COMPANY_IR' },
  'ustr-press': { isOfficial: true, type: 'GOV_TRANSCRIPT' },
  'whitehouse-briefing': { isOfficial: true, type: 'GOV_TRANSCRIPT' },
};
for (const item of items) {
  const meta = sourceMeta[item.source];
  const res = attributePerson({ title: item.title, text: item.text, people, ownerPersonId: peopleMap[item.personSlug]?.id ?? null, sourceIsOfficial: meta.isOfficial, sourceType: meta.type });
  console.log(`idx=${item.idx} person=${item.person} source=${item.source} -> attributed=${res.attributed} reason="${res.reason}"`);
}
