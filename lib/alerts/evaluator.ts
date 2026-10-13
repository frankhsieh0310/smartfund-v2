export const ALERT_AVAILABILITY = ['AVAILABLE','PARTIAL','UPDATING','SCHEDULED_WAIT','SOURCE_LIMITED','NOT_AVAILABLE'] as const;
export type AlertAvailability = (typeof ALERT_AVAILABILITY)[number];
export type AlertOperator = 'ABOVE'|'BELOW'|'CROSS_ABOVE'|'CROSS_BELOW'|'PERCENT_CHANGE'|'ABSOLUTE_CHANGE'|'EQUALS'|'GREATER_THAN_METRIC'|'LESS_THAN_METRIC';
export type AlertCondition = { id:string; assetId:string; assetType:string; metric:string; operator:AlertOperator; threshold?:number; compareMetric?:string };
export type AlertObservation = { value:number|null; previousValue?:number|null; compareValue?:number|null; availability:AlertAvailability };

const closed = new Set<AlertAvailability>(['UPDATING','SCHEDULED_WAIT','SOURCE_LIMITED','NOT_AVAILABLE']);
export function evaluateCondition(condition:AlertCondition, observation:AlertObservation):boolean {
  if(closed.has(observation.availability)||observation.value==null||!Number.isFinite(observation.value)) return false;
  const value=observation.value, previous=observation.previousValue, threshold=condition.threshold;
  if(condition.operator==='ABOVE') return threshold!=null&&value>threshold;
  if(condition.operator==='BELOW') return threshold!=null&&value<threshold;
  if(condition.operator==='CROSS_ABOVE') return threshold!=null&&previous!=null&&previous<=threshold&&value>threshold;
  if(condition.operator==='CROSS_BELOW') return threshold!=null&&previous!=null&&previous>=threshold&&value<threshold;
  if(condition.operator==='PERCENT_CHANGE') return threshold!=null&&previous!=null&&previous!==0&&((value/previous)-1)*100>=threshold;
  if(condition.operator==='ABSOLUTE_CHANGE') return threshold!=null&&previous!=null&&Math.abs(value-previous)>=threshold;
  if(condition.operator==='EQUALS') return threshold!=null&&value===threshold;
  if(condition.operator==='GREATER_THAN_METRIC') return observation.compareValue!=null&&value>observation.compareValue;
  return observation.compareValue!=null&&value<observation.compareValue;
}
export function evaluateComposite(logic:'AND'|'OR',conditions:readonly AlertCondition[],observations:Readonly<Record<string,AlertObservation>>):boolean {
  if(!conditions.length) return false; const results=conditions.map(condition=>evaluateCondition(condition,observations[condition.id]??{value:null,availability:'NOT_AVAILABLE'}));
  return logic==='AND'?results.every(Boolean):results.some(Boolean);
}
