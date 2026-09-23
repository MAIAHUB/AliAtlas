export const COLORS = {
  organ: '#78d4be',
  bone: '#93b8ee',
  vessel: '#e79ba5',
  muscle: '#bd9de9',
  gland: '#e7c58b',
};
export const REGIONS = [
  { id: 'headneck', name: 'Head & neck', description: 'Brain, neck vessels, glands and muscles' },
  { id: 'chest', name: 'Chest', description: 'Lungs, heart, vessels and thoracic structures' },
  { id: 'abdomen', name: 'Abdomen', description: 'Liver, kidneys, bowel and abdominal structures' },
  { id: 'pelvis', name: 'Pelvis', description: 'Pelvic organs, bones and muscles' },
  { id: 'wholebody', name: 'Whole body', description: 'Major CT structures across the scan' },
];
export function regionForSeries(series) {
  const bodyPart = (series.bodyPart || '').toUpperCase();
  if (/HEAD|NECK|BRAIN/.test(bodyPart)) return 'headneck';
  if (/CHEST|THORAX|LUNG/.test(bodyPart)) return 'chest';
  if (/ABDOM/.test(bodyPart)) return 'abdomen';
  if (/PELVIS/.test(bodyPart)) return 'pelvis';
  return 'wholebody';
}
export const PRESETS = [
  { id: 'soft', name: 'Soft tissue', width: 350, center: 40 },
  { id: 'brain', name: 'Brain', width: 80, center: 40 },
  { id: 'lung', name: 'Lung', width: 1500, center: -600 },
  { id: 'bone', name: 'Bone', width: 1800, center: 400 },
];
export const MANUAL_LABELS = [
  'Globe',
  'Zygomatic bone',
  'Ethmoid air cells',
  'Sphenoid sinus',
  'Nasal septum',
  'Nasal cavity',
  'Maxillary sinus',
  'Maxilla',
  'Mandibular ramus',
  'Masseter muscle',
  'Lateral pterygoid muscle',
  'Medial pterygoid muscle',
  'Parotid gland',
  'Internal carotid artery',
  'Internal jugular vein',
  'Sternocleidomastoid muscle',
  'Nasopharyngeal airway',
  'Oropharyngeal airway',
  'Cervical spinal canal',
  'Tongue',
  'C2 vertebral body',
  'C3 vertebral body',
  'Lung',
  'Heart',
  'Aorta',
  'Liver',
  'Spleen',
  'Kidney',
  'Pancreas',
  'Urinary bladder',
];
export function structureName(key) {
  const aliases = {
    eye: 'Globe',
    nasopharynx: 'Nasopharyngeal airway',
    oropharynx: 'Oropharyngeal airway',
    hypopharynx: 'Hypopharyngeal airway',
  };
  const suffix = key.endsWith('_left') ? ' (left)' : key.endsWith('_right') ? ' (right)' : '';
  const root = key.replace(/_(left|right)$/, '');
  if (aliases[root]) return aliases[root] + suffix;
  const human = root.replace(/^vertebrae_([CTL]\d+)$/, '$1 vertebra').replaceAll('_', ' ');
  return human[0].toUpperCase() + human.slice(1) + suffix;
}
export function structureCategory(key) {
  if (/artery|vein|vena|aorta|vessel/.test(key)) return 'vessel';
  if (
    /bone|vertebra|skull|rib_|humerus|femur|sacrum|scapula|clavicula|hip_|cartilage|zygomatic|hyoid/.test(
      key,
    )
  )
    return 'bone';
  if (/gland|parotid/.test(key)) return 'gland';
  if (
    /muscle|pterygoid|masseter|temporalis|sternocleidomastoid|trapezius|scalene|digastric|psoas|gluteus|platysma|constrictor|levator|thyrohyoid|prevertebral/.test(
      key,
    )
  )
    return 'muscle';
  return 'organ';
}
export const tasksForRegion = (region) =>
  region === 'headneck'
    ? [
        'total',
        'head_glands_cavities',
        'head_muscles',
        'headneck_bones_vessels',
        'headneck_muscles',
      ]
    : ['total'];
