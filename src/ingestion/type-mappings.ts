import { readFileSync, writeFileSync, existsSync } from 'fs';

export type NoteType =
  | 'lecture'
  | 'reading'
  | 'exam-prep'
  | 'assignment'
  | 'compendium'
  | 'project'
  | 'reference'
  | 'personal'
  | 'external';

const BUILT_IN_MAPPINGS: Record<string, NoteType> = {
  forelesninger: 'lecture',
  lectures: 'lecture',
  slides: 'lecture',
  presentasjoner: 'lecture',

  pensum: 'reading',
  litteratur: 'reading',
  readings: 'reading',
  artikler: 'reading',

  eksamenslesning: 'exam-prep',
  eksamen: 'exam-prep',
  exam: 'exam-prep',
  'tidligere eksamener': 'exam-prep',

  tasks: 'assignment',
  oppgaver: 'assignment',
  innleveringer: 'assignment',
  øvinger: 'assignment',

  kompendium: 'compendium',
  summary: 'compendium',
  sammendrag: 'compendium',

  prosjekt: 'project',
  project: 'project',
  bacheloroppgave: 'project',
  masteroppgave: 'project',

  ressurser: 'reference',
  resources: 'reference',
  vedlegg: 'reference',
};

export class TypeMappings {
  private configPath: string;
  private customMappings: Record<string, NoteType> = {};

  constructor(configPath: string) {
    this.configPath = configPath;
    if (configPath !== '' && existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        this.customMappings = JSON.parse(raw) as Record<string, NoteType>;
      } catch {
        this.customMappings = {};
      }
    }
  }

  classifyFolder(folderName: string): NoteType | null {
    const lower = folderName.toLowerCase();
    if (lower in this.customMappings) {
      return this.customMappings[lower];
    }
    if (lower in BUILT_IN_MAPPINGS) {
      return BUILT_IN_MAPPINGS[lower];
    }
    return null;
  }

  async learn(folderName: string, type: NoteType): Promise<void> {
    const lower = folderName.toLowerCase();
    this.customMappings[lower] = type;
    if (this.configPath !== '') {
      writeFileSync(
        this.configPath,
        JSON.stringify(this.customMappings, null, 2),
        'utf-8',
      );
    }
  }
}
