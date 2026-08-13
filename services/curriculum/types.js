/**
 * Shared JSDoc typedefs for the curriculum provider layer. No runtime
 * behavior — this file exists purely so every provider/route can reference
 * the same shapes via `@typedef` imports instead of drifting.
 *
 * @typedef {'READY'|'COMING_SOON'|'UNDER_REVIEW'|'NOT_AVAILABLE'} ResourceStatus
 * @typedef {'AI_EXPLANATION'|'IMAGES'|'AUDIO'|'PRACTICE'|'FLASHCARDS'|'WORKSHEETS'|'BOOK_REFERENCE'|'OER_MAPPING'} ResourceType
 * @typedef {'OFFICIAL_BOOK'|'LICENSED_CONTENT'|'MAPPED_OER'|'ORIGINAL_AI'|'PLACEHOLDER'} ResourceSourceTier
 *
 * @typedef {Object} LearningResource
 * @property {string} id
 * @property {string} topicId
 * @property {ResourceType} resourceType
 * @property {ResourceStatus} status
 * @property {ResourceSourceTier|null} sourceTier
 * @property {string|null} source
 * @property {{text?:string, imageUrl?:string, audioUrl?:string, pageRef?:number, pdfUrl?:string, items?:unknown[], attribution?:string}|null} payload
 *
 * @typedef {Object} CurriculumTopic
 * @property {string} id
 * @property {string} chapterId
 * @property {string} name
 * @property {number} order
 * @property {string} [kind]
 * @property {string[]} [learningObjectives]
 *
 * @typedef {Object} ResolvedTopicContent
 * @property {CurriculumTopic} topic
 * @property {LearningResource[]} resources
 *
 * @typedef {Object} CurriculumProviderMeta
 * @property {string} id
 * @property {string} displayName
 *
 * @typedef {Object} CurriculumProvider
 * @property {CurriculumProviderMeta} meta
 * @property {() => Promise<Array<{id:string,label:string}>>} listGrades
 * @property {(gradeId: string) => Promise<Array<{id:string,label:string}>>} listSubjects
 * @property {(gradeId: string, subjectId: string) => Promise<{units: object[], chapters: object[]}>} listUnitsAndChapters
 * @property {(chapterId: string) => Promise<CurriculumTopic[]>} listTopics
 * @property {(topicId: string) => Promise<ResolvedTopicContent>} getTopicContent
 * @property {(query: string, opts: {gradeId?:string, subjectId?:string, limit?:number}) => Promise<Array<{topicId:string,snippet:string,score:number}>>} search
 */

/** All eight resource types every provider must resolve for a topic. */
const RESOURCE_TYPES = [
  'AI_EXPLANATION', 'IMAGES', 'AUDIO', 'PRACTICE',
  'FLASHCARDS', 'WORKSHEETS', 'BOOK_REFERENCE', 'OER_MAPPING',
];

module.exports = { RESOURCE_TYPES };
