'use client';
// UI dictionary: English, Hindi, Telugu. Nav, headings, buttons and status words.
// Money values, IDs and proof come from data and are never translated.
import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'en' | 'hi' | 'te';
export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'hi', label: 'हिन्दी', short: 'हिन्दी' },
  { id: 'te', label: 'తెలుగు', short: 'తెలుగు' },
];

const en = {
  'nav.today': 'Today', 'nav.bill': 'To bill', 'nav.collect': 'To collect', 'nav.customers': 'Customers', 'nav.approvals': 'Approvals',
  'nav.unlinked': 'Unlinked', 'nav.ask': 'Ask', 'nav.reports': 'Reports', 'nav.business': 'Business', 'nav.setup': 'Setup',
  'nav.connections': 'Connections', 'nav.settings': 'Settings', 'nav.advanced': 'Advanced', 'nav.agents': 'Agent activity',
  'nav.audit': 'Audit log', 'nav.eval': 'Eval & chaos', 'nav.cases': 'All cases', 'nav.triage': 'Triage review',
  'nav.escalations': 'Escalations', 'nav.demo': 'Demo control room', 'nav.metrics': 'Metrics', 'nav.approve': 'Approve',
  'top.search': 'Ask anything about your money', 'top.demo': 'Demo', 'top.demoData': 'Demo data', 'top.signout': 'Sign out',
  'today.title': 'Today', 'today.sub': 'What needs you today.',
  'strip.notBilled': 'Delivered, not billed', 'strip.overdue': 'Billed, overdue', 'strip.recovered': 'Recovered this month', 'strip.waiting': 'Waiting for you',
  'today.billThese': 'Bill these today', 'today.waiting': 'Waiting on you', 'today.chase': 'Payments to chase', 'today.flow': 'Money flow',
  'today.leakBy': 'Where the leak is', 'today.live': "What's happening now", 'today.replay': 'Replay PO-184 live',
  'flow.ordered': 'Ordered', 'flow.delivered': 'Delivered', 'flow.billed': 'Billed', 'flow.paid': 'Paid',
  'period.month': 'This month', 'period.30d': 'Last 30 days', 'period.quarter': 'Quarter',
  'btn.approve': 'Approve', 'btn.reject': 'Reject', 'btn.edit': 'Edit', 'btn.open': 'Open', 'btn.review': 'Review', 'btn.seeAll': 'See all',
  'btn.bill': 'Bill', 'btn.remind': 'Remind', 'btn.snooze': 'Snooze', 'btn.link': 'Link to PO', 'btn.ignore': 'Ignore', 'btn.export': 'Export',
  'btn.save': 'Save', 'btn.cancel': 'Cancel', 'btn.retry': 'Try again', 'btn.wrong': 'This is wrong', 'btn.send': 'Send', 'btn.approveSelected': 'Approve selected',
  'st.not_billed': 'Not billed', 'st.partial': 'Under-billed', 'st.needs_check': 'Needs check', 'st.billed': 'Billed', 'st.paid': 'Paid',
  'st.overdue': 'Overdue', 'st.verified': 'Verified', 'st.waiting': 'Waiting', 'st.good': 'Good', 'st.watch': 'Watch', 'st.high': 'High risk',
  'st.expired': 'Expired', 'st.approved': 'Approved', 'st.rejected': 'Rejected', 'st.closed': 'Closed',
  'bill.title': 'To bill', 'bill.sub': 'Delivered but not billed. Every row has proof.',
  'collect.title': 'To collect', 'collect.sub': 'Billed, not paid. Every reminder needs your OK.',
  'approvals.title': 'Approvals', 'approvals.sub': 'Nothing is billed or sent without a person saying yes.',
  'customers.title': 'Customers', 'customers.sub': 'Who owes you what, and who pays on time.',
  'unlinked.title': 'Unlinked', 'unlinked.sub': 'Messages we could not match to an order. Nothing is lost: put each one where it belongs.',
  'ask.title': 'Questions about your money, answered with proof', 'ask.placeholder': 'Ask in English, Hindi or Telugu…',
  'reports.title': 'Reports', 'reports.sub': 'For month-end and for your CA. Every number links back to its proof.',
  'settings.title': 'Settings', 'settings.sub': 'Who can do what, how you hear from us, and your billing rules.',
  'connections.title': 'Connections', 'connections.sub': 'What RevenueGuard can read, and whether it is working.',
  'case.why': 'Why we think so', 'case.invoice': 'Invoice to create', 'case.how': 'How RevenueGuard found this',
  'empty.loading': 'Loading…', 'empty.error': 'Something went wrong. Your data is safe.', 'empty.none': 'Nothing here right now.',
};
type Dict = typeof en;
export type TKey = keyof Dict;

const hi: Partial<Dict> = {
  'nav.today': 'आज', 'nav.bill': 'बिल बनाना है', 'nav.collect': 'वसूली', 'nav.customers': 'ग्राहक', 'nav.approvals': 'मंज़ूरी',
  'nav.unlinked': 'बिना मिलान', 'nav.ask': 'पूछें', 'nav.reports': 'रिपोर्ट', 'nav.business': 'व्यापार', 'nav.setup': 'सेटअप',
  'nav.connections': 'कनेक्शन', 'nav.settings': 'सेटिंग्स', 'nav.advanced': 'एडवांस्ड', 'nav.approve': 'मंज़ूरी',
  'top.search': 'अपने पैसे के बारे में कुछ भी पूछें', 'top.demo': 'डेमो', 'top.demoData': 'डेमो डेटा', 'top.signout': 'साइन आउट',
  'today.title': 'आज', 'today.sub': 'आज आपको क्या करना है।',
  'strip.notBilled': 'डिलीवर हुआ, बिल नहीं', 'strip.overdue': 'बिल हुआ, बकाया', 'strip.recovered': 'इस महीने वसूला', 'strip.waiting': 'आपकी मंज़ूरी बाकी',
  'today.billThese': 'आज इनका बिल बनाएं', 'today.waiting': 'आपका इंतज़ार', 'today.chase': 'भुगतान वसूली', 'today.flow': 'पैसे का बहाव',
  'today.leakBy': 'नुकसान कहाँ है', 'today.live': 'अभी क्या हो रहा है', 'today.replay': 'PO-184 फिर से चलाएं',
  'flow.ordered': 'ऑर्डर', 'flow.delivered': 'डिलीवर', 'flow.billed': 'बिल हुआ', 'flow.paid': 'भुगतान',
  'period.month': 'इस महीने', 'period.30d': 'पिछले 30 दिन', 'period.quarter': 'तिमाही',
  'btn.approve': 'मंज़ूर करें', 'btn.reject': 'अस्वीकार', 'btn.edit': 'बदलें', 'btn.open': 'खोलें', 'btn.review': 'देखें', 'btn.seeAll': 'सब देखें',
  'btn.bill': 'बिल बनाएं', 'btn.remind': 'याद दिलाएं', 'btn.snooze': 'बाद में', 'btn.link': 'PO से जोड़ें', 'btn.ignore': 'छोड़ें', 'btn.export': 'डाउनलोड',
  'btn.save': 'सेव करें', 'btn.cancel': 'रद्द', 'btn.retry': 'फिर कोशिश करें', 'btn.wrong': 'यह गलत है', 'btn.send': 'भेजें', 'btn.approveSelected': 'चुने हुए मंज़ूर करें',
  'st.not_billed': 'बिल नहीं हुआ', 'st.partial': 'कम बिल हुआ', 'st.needs_check': 'जाँच ज़रूरी', 'st.billed': 'बिल हुआ', 'st.paid': 'भुगतान हुआ',
  'st.overdue': 'बकाया', 'st.verified': 'जाँचा गया', 'st.waiting': 'इंतज़ार', 'st.good': 'अच्छा', 'st.watch': 'ध्यान दें', 'st.high': 'ज़्यादा जोखिम',
  'st.expired': 'रद्द हुआ', 'st.approved': 'मंज़ूर', 'st.rejected': 'अस्वीकार', 'st.closed': 'पूरा',
  'bill.title': 'बिल बनाना है', 'bill.sub': 'डिलीवर हुआ पर बिल नहीं बना। हर लाइन का सबूत है।',
  'collect.title': 'वसूली', 'collect.sub': 'बिल हुआ, भुगतान नहीं। हर रिमाइंडर आपकी मंज़ूरी से जाता है।',
  'approvals.title': 'मंज़ूरी', 'approvals.sub': 'आपकी हाँ के बिना न बिल बनता है, न मैसेज जाता है।',
  'customers.title': 'ग्राहक', 'customers.sub': 'किस पर कितना बाकी है, और कौन समय पर देता है।',
  'unlinked.title': 'बिना मिलान', 'unlinked.sub': 'जो मैसेज किसी ऑर्डर से नहीं मिले। कुछ खोया नहीं है।',
  'ask.title': 'अपने पैसे के सवाल, सबूत के साथ जवाब', 'ask.placeholder': 'हिंदी, अंग्रेज़ी या तेलुगु में पूछें…',
  'reports.title': 'रिपोर्ट', 'reports.sub': 'महीने के अंत और आपके CA के लिए।',
  'settings.title': 'सेटिंग्स', 'settings.sub': 'कौन क्या कर सकता है, और बिलिंग नियम।',
  'connections.title': 'कनेक्शन', 'connections.sub': 'RevenueGuard क्या पढ़ सकता है, और क्या वह चल रहा है।',
  'case.why': 'हमें ऐसा क्यों लगता है', 'case.invoice': 'बनने वाला बिल', 'case.how': 'RevenueGuard ने यह कैसे खोजा',
  'empty.loading': 'लोड हो रहा है…', 'empty.error': 'कुछ गड़बड़ हुई। आपका डेटा सुरक्षित है।', 'empty.none': 'अभी यहाँ कुछ नहीं है।',
};

const te: Partial<Dict> = {
  'nav.today': 'ఈరోజు', 'nav.bill': 'బిల్ చేయాలి', 'nav.collect': 'వసూలు', 'nav.customers': 'కస్టమర్లు', 'nav.approvals': 'ఆమోదాలు',
  'nav.unlinked': 'లింక్ కానివి', 'nav.ask': 'అడగండి', 'nav.reports': 'రిపోర్టులు', 'nav.business': 'వ్యాపారం', 'nav.setup': 'సెటప్',
  'nav.connections': 'కనెక్షన్లు', 'nav.settings': 'సెట్టింగ్స్', 'nav.advanced': 'అడ్వాన్స్‌డ్', 'nav.approve': 'ఆమోదం',
  'top.search': 'మీ డబ్బు గురించి ఏదైనా అడగండి', 'top.demo': 'డెమో', 'top.demoData': 'డెమో డేటా', 'top.signout': 'సైన్ అవుట్',
  'today.title': 'ఈరోజు', 'today.sub': 'ఈరోజు మీరు చేయాల్సినవి.',
  'strip.notBilled': 'డెలివరీ అయింది, బిల్ కాలేదు', 'strip.overdue': 'బిల్ అయింది, బాకీ', 'strip.recovered': 'ఈ నెల వసూలు', 'strip.waiting': 'మీ ఆమోదం కోసం',
  'today.billThese': 'ఈరోజు వీటికి బిల్ చేయండి', 'today.waiting': 'మీ కోసం వేచి ఉన్నవి', 'today.chase': 'వసూలు చేయాల్సినవి', 'today.flow': 'డబ్బు ప్రవాహం',
  'today.leakBy': 'నష్టం ఎక్కడ', 'today.live': 'ఇప్పుడు జరుగుతున్నది', 'today.replay': 'PO-184 మళ్ళీ చూపించు',
  'flow.ordered': 'ఆర్డర్', 'flow.delivered': 'డెలివరీ', 'flow.billed': 'బిల్', 'flow.paid': 'చెల్లింపు',
  'period.month': 'ఈ నెల', 'period.30d': 'గత 30 రోజులు', 'period.quarter': 'త్రైమాసికం',
  'btn.approve': 'ఆమోదించు', 'btn.reject': 'తిరస్కరించు', 'btn.edit': 'మార్చు', 'btn.open': 'తెరువు', 'btn.review': 'చూడండి', 'btn.seeAll': 'అన్నీ చూడండి',
  'btn.bill': 'బిల్ చేయి', 'btn.remind': 'గుర్తు చేయి', 'btn.snooze': 'తర్వాత', 'btn.link': 'PO కి జోడించు', 'btn.ignore': 'వదిలేయి', 'btn.export': 'డౌన్‌లోడ్',
  'btn.save': 'సేవ్', 'btn.cancel': 'రద్దు', 'btn.retry': 'మళ్ళీ ప్రయత్నించు', 'btn.wrong': 'ఇది తప్పు', 'btn.send': 'పంపు', 'btn.approveSelected': 'ఎంచుకున్నవి ఆమోదించు',
  'st.not_billed': 'బిల్ కాలేదు', 'st.partial': 'తక్కువ బిల్', 'st.needs_check': 'చెక్ చేయాలి', 'st.billed': 'బిల్ అయింది', 'st.paid': 'చెల్లించారు',
  'st.overdue': 'బాకీ', 'st.verified': 'తనిఖీ అయింది', 'st.waiting': 'వేచి ఉంది', 'st.good': 'బాగుంది', 'st.watch': 'గమనించండి', 'st.high': 'ఎక్కువ రిస్క్',
  'st.expired': 'రద్దయింది', 'st.approved': 'ఆమోదించారు', 'st.rejected': 'తిరస్కరించారు', 'st.closed': 'పూర్తి',
  'bill.title': 'బిల్ చేయాలి', 'bill.sub': 'డెలివరీ అయింది కానీ బిల్ కాలేదు. ప్రతి దానికీ రుజువు ఉంది.',
  'collect.title': 'వసూలు', 'collect.sub': 'బిల్ అయింది, చెల్లించలేదు. ప్రతి రిమైండర్‌కు మీ ఆమోదం కావాలి.',
  'approvals.title': 'ఆమోదాలు', 'approvals.sub': 'మీరు సరే అనకుండా ఏ బిల్లూ, ఏ మెసేజ్ వెళ్ళదు.',
  'customers.title': 'కస్టమర్లు', 'customers.sub': 'ఎవరు ఎంత బాకీ, ఎవరు సమయానికి చెల్లిస్తారు.',
  'unlinked.title': 'లింక్ కానివి', 'unlinked.sub': 'ఏ ఆర్డర్‌తోనూ సరిపోని మెసేజ్‌లు. ఏదీ పోలేదు.',
  'ask.title': 'మీ డబ్బు ప్రశ్నలు, రుజువుతో జవాబులు', 'ask.placeholder': 'తెలుగు, హిందీ లేదా ఇంగ్లీష్‌లో అడగండి…',
  'reports.title': 'రిపోర్టులు', 'reports.sub': 'నెలాఖరు కోసం, మీ CA కోసం.',
  'settings.title': 'సెట్టింగ్స్', 'settings.sub': 'ఎవరు ఏమి చేయగలరు, బిల్లింగ్ నియమాలు.',
  'connections.title': 'కనెక్షన్లు', 'connections.sub': 'RevenueGuard ఏమి చదవగలదు, అది పని చేస్తోందా.',
  'case.why': 'మేము ఎందుకు అనుకుంటున్నాం', 'case.invoice': 'చేయాల్సిన బిల్', 'case.how': 'RevenueGuard దీన్ని ఎలా కనుగొంది',
  'empty.loading': 'లోడ్ అవుతోంది…', 'empty.error': 'ఏదో తప్పు జరిగింది. మీ డేటా సురక్షితం.', 'empty.none': 'ప్రస్తుతం ఇక్కడ ఏమీ లేదు.',
};

export const DICTS: Record<Lang, Partial<Dict>> = { en, hi, te };

interface LangState { lang: Lang; setLang: (l: Lang) => void }
export const useLang = create<LangState>()(persist((set) => ({ lang: 'en', setLang: (lang) => set({ lang }) }), { name: 'rg.lang' }));

export function translate(lang: Lang, k: TKey): string {
  return DICTS[lang][k] ?? en[k] ?? k;
}

/** t('nav.today') in the current language; keeps <html lang> in sync for the Noto fonts. */
export function useT() {
  const lang = useLang((s) => s.lang);
  useEffect(() => { if (typeof document !== 'undefined') document.documentElement.lang = lang === 'en' ? 'en-IN' : lang; }, [lang]);
  return Object.assign((k: TKey) => translate(lang, k), { lang });
}
