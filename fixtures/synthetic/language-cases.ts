import { preprocessDescription } from '../../packages/domain/src/index.js';
import { generateSyntheticCorpus, type CorpusMetadata } from './corpus.js';

export type LanguageCase = { id: string; family: string; split: 'dev' | 'test'; language: 'en' | 'fr' | 'sw';
  text: string; expected: 'comparison' | 'clarification' | 'abstention'; sourceId?: string; metadata?: CorpusMetadata;
  authorship: 'implementation-team'; reviewStatus: 'synthetic_unreviewed'; limitation: string };
const french = {
  s: ['Les grains de café en parche ont des tailles variées et des défauts visibles.', 'Les morceaux les plus abîmés ont été retirés.', 'Le tri manuel a laissé un lot propre et uniforme, sans grains cassés.'],
  h: ['Le café est bien séché et conservé à l’abri dans un endroit sec.', 'Un peu d’humidité est revenue pendant le stockage.', 'Le stockage humide a donné une odeur de moisi à certains grains.'],
  b: ['Le café se trouve dans des sacs ouverts.', 'Des sacs tissés ordinaires et propres contiennent le café.', 'Des sacs fermés avec une doublure protègent le café de l’humidité.'],
  t: ['Le camion de l’acheteur peut venir charger à côté du café.', 'Il faut porter les sacs sur une courte distance jusqu’à la route.', 'La ferme est difficile d’accès et les sacs doivent être portés longtemps jusqu’à la route.'],
};
export function generateLanguageCases(): LanguageCase[] {
  const corpus = generateSyntheticCorpus(); const cases: LanguageCase[] = [];
  for (const split of ['dev', 'test'] as const) {
    const selected = corpus.records.filter(record => corpus.metadata[record.id]!.split === split && !corpus.metadata[record.id]!.stressType).slice(0, split === 'dev' ? 12 : 20);
    for (const record of selected) {
      const metadata = corpus.metadata[record.id]!; const family = `language-${split}-${record.id}`;
      const phrases = metadata.observedFactors.map(key => french[key][metadata.latentFactors[key]]!).join(' ');
      const text = `Je vends ${record.facts.quantityKg.value} kg de café arabica en parche à la ferme. ${phrases} L’acheteur vient chercher le café et paie immédiatement.`;
      for (const language of ['en', 'fr'] as const) cases.push({ id: `${family}-${language}`, family, split, language,
        text: language === 'en' ? preprocessDescription(record.originalText).description : text,
        expected: 'comparison', sourceId: record.id, metadata, authorship: 'implementation-team', reviewStatus: 'synthetic_unreviewed',
        limitation: 'Team-authored synthetic query and translation; no independent agricultural comparability review.' });
    }
  }
  const swahili: { split: 'dev' | 'test'; text: string; expected: LanguageCase['expected'] }[] = [
    { split: 'dev', text: 'Ninauza 50 kg za kahawa ya Arabica yenye maganda ya parchment. Kahawa imekaushwa vizuri na kuhifadhiwa kwenye magunia safi yaliyofungwa. Mnunuzi anachukua shambani na analipa papo hapo. Ofa ni TZS 300000 kwa lote; hakuna makato.', expected: 'comparison' },
    { split: 'dev', text: 'Nina magunia mawili ya kahawa ya Arabica. Sijui uzito wake. Mnunuzi anatoa TZS 300000 kwa magunia yote.', expected: 'clarification' },
    { split: 'dev', text: 'Hizi ni cherries za kahawa, si parchment. Mnunuzi atachukua shambani.', expected: 'abstention' },
    { split: 'test', text: 'Kahawa ya Arabica ya parchment imechambuliwa kwa mkono. Imehifadhiwa mahali pakavu. Mnunuzi anachukua shambani na analipa papo hapo. Bei ni TZS 6000 kwa kilo; hakuna makato.', expected: 'comparison' },
    { split: 'test', text: 'Kahawa imehifadhiwa mahali penye unyevu na ina harufu ya ukungu. Magunia yako wazi. Ni Arabica ya parchment na mnunuzi anachukua shambani. Bei ni TZS 6000 kwa kilo; hakuna makato.', expected: 'comparison' },
    { split: 'test', text: 'Mnunuzi anasema atalipa baada ya siku thelathini. Ni kahawa ya Arabica ya parchment, lakini muda wa malipo haujathibitishwa.', expected: 'clarification' },
  ];
  swahili.forEach((item, index) => cases.push({ id: `kiswahili-${index + 1}`, family: `kiswahili-intent-${index + 1}`, ...item, language: 'sw',
    authorship: 'implementation-team', reviewStatus: 'synthetic_unreviewed',
    limitation: 'Machine-assisted Kiswahili wording has no independent fluent agricultural review; expected behavior is provisional.' }));
  return cases;
}
