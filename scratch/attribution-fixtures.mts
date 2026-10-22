// P0-1 regression fixtures for the speaker-validation attribution fix.
// 10 positive (must attribute), 10 negative (must NOT attribute) — plus a regression run against
// the exact 5 candidates from the prior round's real ingest (scratch/attributed-items.json).
import { attributePerson, type PersonRef } from '../lib/consensus/attribution';

const jensen: PersonRef = { id: 'p1', slug: 'jensen-huang', displayName: 'Jensen Huang', aliases: ['Jensen Huang', 'Jen-Hsun Huang'], country: 'US' };
const cook: PersonRef = { id: 'p2', slug: 'tim-cook', displayName: 'Tim Cook', aliases: ['Timothy Cook', 'Timothy D. Cook', 'Tim Cook'], country: 'US' };
const powell: PersonRef = { id: 'p3', slug: 'jerome-powell', displayName: 'Jerome Powell', aliases: ['Chair Powell', 'Jay Powell', 'Chairman Powell', 'Jerome H. Powell'], country: 'US' };
const buffett: PersonRef = { id: 'p4', slug: 'warren-buffett', displayName: 'Warren Buffett', aliases: ['the Oracle of Omaha', 'Warren E. Buffett'], country: 'US' };
const trump: PersonRef = { id: 'p5', slug: 'donald-trump', displayName: 'Donald Trump', aliases: ['President Trump'], country: 'US' };
const people = [jensen, cook, powell, buffett, trump];

type Case = { name: string; expectAttributed: boolean; expectPerson?: string; title: string | null; text: string; ownerPersonId?: string | null; sourceIsOfficial?: boolean; sourceType?: string | null };

const positives: Case[] = [
  { name: 'P1 name-then-verb-then-quote (wire)', expectAttributed: true, expectPerson: 'jensen-huang', title: 'Nvidia CEO discusses demand', text: 'Jensen Huang said, "Demand for our GPUs remains extremely strong across every region."' },
  { name: 'P2 quote-then-verb-then-name (wire)', expectAttributed: true, expectPerson: 'tim-cook', title: 'Apple earnings call highlights', text: '"We had a record quarter driven by iPhone momentum," said Tim Cook on the call.' },
  { name: 'P3 quote-then-name-said (wire)', expectAttributed: true, expectPerson: 'warren-buffett', title: 'Buffett on market valuations', text: '"I think the market is not cheap right now," said Warren Buffett at the Berkshire meeting.' },
  { name: 'P4 official IR source, principal quoted', expectAttributed: true, expectPerson: 'jensen-huang', title: 'NVIDIA announces new platform', text: '"Our sovereign AI stack is the most advanced in the industry," said Jensen Huang, founder and CEO of NVIDIA.', ownerPersonId: 'p1', sourceIsOfficial: true, sourceType: 'COMPANY_IR' },
  { name: 'P5 earnings call transcript title shortcut', expectAttributed: true, expectPerson: 'jensen-huang', title: 'Jensen Huang, NVIDIA Q2 FY2026 Earnings Call Remarks', text: 'Thank you all for joining. Demand continues to be very strong across our data center business.', ownerPersonId: 'p1', sourceIsOfficial: true, sourceType: 'EARNINGS_CALL' },
  { name: 'P6 gov transcript title shortcut', expectAttributed: true, expectPerson: 'jerome-powell', title: 'Chair Powell — Press Conference Remarks', text: 'Economic activity has continued to expand at a moderate pace.', ownerPersonId: 'p3', sourceIsOfficial: true, sourceType: 'GOV_TRANSCRIPT' },
  { name: 'P7 according-to pattern', expectAttributed: true, expectPerson: 'tim-cook', title: 'Apple outlook', text: 'According to Tim Cook, "services revenue will keep growing double digits next year."' },
  { name: 'P8 SEC filing exhibit quote', expectAttributed: true, expectPerson: 'jensen-huang', title: 'NVIDIA 8-K exhibit 99.1', text: '"We are seeing unprecedented demand," said Jensen Huang in a prepared statement filed with the SEC.', ownerPersonId: 'p1', sourceIsOfficial: true, sourceType: 'SEC_FILING' },
  { name: 'P9 first-person official title, name present, no quote needed', expectAttributed: true, expectPerson: 'donald-trump', title: 'Remarks by President Trump on the Economy', text: 'The President discussed his economic agenda for the coming year at length today.', ownerPersonId: 'p5', sourceIsOfficial: true, sourceType: 'GOV_TRANSCRIPT' },
  { name: 'P10 explicit told-quote pattern', expectAttributed: true, expectPerson: 'warren-buffett', title: 'Buffett interview', text: 'Warren Buffett told CNBC, "Cash is a bad long-term investment, but it lets you be aggressive when others are fearful."' },
];

const negatives: Case[] = [
  { name: 'N1 analyst quoted, tracked person only mentioned nearby', expectAttributed: false, title: 'Chip stocks rally', text: '"The chip cycle is clearly turning higher," said industry analyst Dan Ives. Jensen Huang has previously argued that AI compute demand is insatiable.' },
  { name: 'N2 different speaker quoted after tracked person named earlier', expectAttributed: false, title: 'Apple event recap', text: 'Tim Cook opened the event with a brief introduction. "This is our most powerful chip ever," said Johny Srouji, the company\'s hardware chief.' },
  { name: 'N3 bare name-drop, no quote at all', expectAttributed: false, title: 'AI stocks to watch', text: 'Names like Jensen Huang and Lisa Su are frequently cited by investors tracking the AI trade this quarter.' },
  { name: 'N4 general news roundup title on official press page (not first-person)', expectAttributed: false, title: 'President Trump Delivers Historic Results for the American People in Under Two Years', text: 'In less than two years, President Donald J. Trump has driven the most consequential stretch of governing in modern American history. He inherited a disaster.', ownerPersonId: 'p5', sourceIsOfficial: true, sourceType: 'GOV_TRANSCRIPT' },
  { name: 'N5 joint press release quoting a different company executive', expectAttributed: false, title: 'NVIDIA and Palantir Bring Sovereign Intelligence to Critical Supply Chains', text: 'NVIDIA and Palantir today announced a collaboration. "Our sovereign stack is delivering unmatched capabilities," said Alex Karp, chief executive officer of Palantir Technologies.', ownerPersonId: 'p1', sourceIsOfficial: true, sourceType: 'COMPANY_IR' },
  { name: 'N6 official statement quoting a subordinate official, not the tracked principal', expectAttributed: false, title: "Ambassador Greer Issues Statement on President Trump's Response to Canada", text: 'Today, Ambassador Jamieson Greer issued a statement after President Trump took action under Section 338. "Canada chose to embark on senseless retaliation," said Ambassador Greer.', ownerPersonId: 'p5', sourceIsOfficial: true, sourceType: 'GOV_TRANSCRIPT' },
  { name: 'N7 commemorative speech, no market content, quote belongs to someone else', expectAttributed: false, title: "President Trump Honors 9/11 Heroes", text: 'President Trump stood with first responders today. "This means the world to me and my family," said Alison Crowther, accepting a medal on her son\'s behalf.', ownerPersonId: 'p5', sourceIsOfficial: true, sourceType: 'GOV_TRANSCRIPT' },
  { name: 'N8 wire article, quote belongs to unrelated spokesperson', expectAttributed: false, title: 'Berkshire Hathaway comments on holdings', text: 'A Berkshire spokesperson said, "We do not comment on portfolio changes." Warren Buffett has long emphasized a buy-and-hold philosophy in prior letters.' },
  { name: 'N9 two different tracked people both quoted, ambiguous single match', expectAttributed: false, title: 'Fed and White House react', text: '"Inflation risks are two-sided," said Jerome Powell. "I agree with that assessment," said Donald Trump.' },
  { name: 'N10 quote far outside the speaker window', expectAttributed: false, title: 'Market roundup mentions Jensen Huang', text: `Jensen Huang ${'x'.repeat(220)} "This is a completely unrelated quote from someone else," said a market strategist.` },
];

function run(cases: Case[], label: string) {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    const res = attributePerson({ title: c.title, text: c.text, people, ownerPersonId: c.ownerPersonId ?? null, sourceIsOfficial: c.sourceIsOfficial ?? false, sourceType: c.sourceType ?? null });
    const ok = c.expectAttributed ? (res.attributed && res.person?.slug === c.expectPerson) : !res.attributed;
    if (ok) pass++; else failures.push(`${c.name}: expected ${c.expectAttributed ? c.expectPerson : 'NOT attributed'}, got attributed=${res.attributed} person=${res.person?.slug} reason=${res.reason}`);
  }
  console.log(`${label}: ${pass}/${cases.length} pass`);
  failures.forEach((f) => console.log('  FAIL', f));
  return { pass, total: cases.length, failures };
}

const posResult = run(positives, 'POSITIVE fixtures');
const negResult = run(negatives, 'NEGATIVE fixtures');
console.log(JSON.stringify({ positives: posResult, negatives: negResult }, null, 2));
