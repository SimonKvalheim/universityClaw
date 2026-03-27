import { TypeMappings, type NoteType } from './type-mappings.js';

export interface PathContext {
  semester: number | null;
  year: number | null;
  courseCode: string | null;
  courseName: string | null;
  type: NoteType | null;
  fileName: string;
}

const SEMESTER_RE = /(\d+)\.\s*Semester/i;
const COURSE_RE = /([A-Z]{2,4})\s+(\d{4})\s*-\s*(.+)/;

let defaultMappings: TypeMappings | null = null;

function getDefaultMappings(): TypeMappings {
  if (!defaultMappings) {
    defaultMappings = new TypeMappings('');
  }
  return defaultMappings;
}

export function parseUploadPath(
  relativePath: string,
  typeMappings?: TypeMappings,
): PathContext {
  const mappings = typeMappings ?? getDefaultMappings();
  const segments = relativePath.split('/');
  const fileName = segments[segments.length - 1];
  const folderSegments = segments.slice(0, -1);

  let semester: number | null = null;
  let year: number | null = null;
  let courseCode: string | null = null;
  let courseName: string | null = null;
  let type: NoteType | null = null;

  for (const segment of folderSegments) {
    // Try semester pattern
    const semMatch = SEMESTER_RE.exec(segment);
    if (semMatch) {
      semester = parseInt(semMatch[1], 10);
      year = Math.ceil(semester / 2);
      continue;
    }

    // Try course pattern
    const courseMatch = COURSE_RE.exec(segment);
    if (courseMatch) {
      const letters = courseMatch[1];
      const digits = courseMatch[2];
      courseCode = `${letters}-${digits}`;
      courseName = courseMatch[3].trim();
      continue;
    }

    // Try type classification
    if (type === null) {
      const classified = mappings.classifyFolder(segment);
      if (classified !== null) {
        type = classified;
      }
    }
  }

  return {
    semester,
    year,
    courseCode,
    courseName,
    type,
    fileName,
  };
}
