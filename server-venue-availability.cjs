// Calendar checks use the caller's SQLite transaction; previews are not permits.
const DAY=86400000,OFFSET=8*3600000;
const fail=(code,message)=>Object.assign(Error(message),{status:409,code});
const config=()=>fail('VENUE_CONFIGURATION_REQUIRED','Review the saved venue calendar before starting or changing play.');
const conflict=()=>fail('VENUE_INTERVAL_UNAVAILABLE','Play conflicts with the saved operating hours, closure, event or reservation.');
const time=v=>typeof v==='string'&&/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
const minute=v=>Number(v.slice(0,2))*60+Number(v.slice(3));
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(Date.parse(v+'T00:00:00Z')).toISOString().slice(0,10)===v;
const midnight=ms=>Math.floor((ms+OFFSET)/DAY)*DAY-OFFSET;
const label=ms=>new Date(ms+OFFSET).toISOString().slice(0,10);
const bool=v=>[true,1,'1'].includes(v)?true:[false,0,'0'].includes(v)?false:null;
const active=r=>!['cancelled','completed','pending-refund'].includes(r.status)&&![true,1,'1'].includes(r.isCancelled)&&!r.cancelled_at;
const all=(db,sql)=>new Promise((resolve,reject)=>db.all(sql,(e,r)=>e?reject(e):resolve(r)));
function ids(raw){if(raw===null||raw===undefined||raw==='')return [];let v=raw;if(typeof v==='string'){try{v=JSON.parse(v);}catch{throw config();}}if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!x.trim())||new Set(v).size!==v.length)throw config();return v;}
function evaluateVenueAvailability({settings,closures=[],events=[],reservations=[]},{tableId,session,now,operation='start',excludeReservationId}={}){
 if(typeof tableId!=='string'||!tableId||!session||typeof session.isOpenTime!=='boolean'||!Number.isFinite(now)||!['start','extend','move','preview'].includes(operation))throw config();
 const start=Date.parse(session.startTime);if(!Number.isFinite(start)||start>now)throw config();
 const begins=operation==='start'?start:now;
 const windowTime=operation==='preview'?begins:start;
 let window;for(const anchor of [midnight(windowTime)-DAY,midnight(windowTime)]){const prefix=[0,5,6].includes(new Date(anchor+OFFSET).getUTCDay())?'weekend':'weekday',from=settings[prefix+'StartTime'],to=settings[prefix+'EndTime'];if(!time(from)||!time(to)||from===to)throw config();const opening=anchor+minute(from)*60000;let closing=anchor+minute(to)*60000;if(closing<opening)closing+=DAY;if(windowTime>=opening&&windowTime<closing)window={opening,closing,anchor};}
 if(!window||begins>=window.closing)throw conflict();let limit=window.closing,reason='closing';
 const restrict=(at,why)=>{if(at<=begins)throw conflict();if(at<limit){limit=at;reason=why;}};
 if(session.isOpenTime&&operation!=='move') {const raw=settings.bookingCutoffMinutes,n=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):NaN;if(!Number.isSafeInteger(n)||n<0||n>1440)throw config();if(window.closing-begins<=n*60000)throw fail('VENUE_OPEN_START_CUTOFF','The last-start cutoff for open-time play has been reached.');}
 for(const r of reservations){if(!active(r)||r.id===excludeReservationId)continue;if(r.tableId!==tableId&&r.tableId!==null&&r.tableId!==undefined)continue;const d=typeof r.date==='string'?r.date.slice(0,10):null;if(!date(d)||!time(r.timeSlot)||!Number.isSafeInteger(r.durationHours)||r.durationHours<1||r.durationHours>24||!r.tableId)throw config();const from=Date.parse(d+'T'+r.timeSlot+':00+08:00'),to=from+r.durationHours*3600000;if(to<=begins)continue;if(from<=begins)throw conflict();restrict(from,'reservation');}
 // Partial hours override the originating operating-date window as one span.
 // Full-day closures independently cover every calendar date actually touched.
 for(const c of closures){
  const weekly=c.type==='weekly';if(weekly?(!Number.isInteger(c.day_of_week)||c.day_of_week<0||c.day_of_week>6):!date(c.closed_date))throw config();
  const full=bool(c.is_full_day);if(full===null)throw config();
  const matches=day=>weekly?c.day_of_week===new Date(day+OFFSET).getUTCDay():c.closed_date===label(day);
  if(full){for(let day=midnight(begins);day<window.closing;day+=DAY)if(matches(day)){if(day<=begins)throw conflict();restrict(day,'closure');}continue;}
  if(!matches(window.anchor))continue;
  if(!time(c.open_time)||!time(c.close_time)||c.open_time===c.close_time)throw config();
  const from=window.anchor+minute(c.open_time)*60000;let to=window.anchor+minute(c.close_time)*60000;if(to<=from)to+=DAY;
  if(begins<from||begins>=to)throw conflict();restrict(to,'closure');
 }
 for(const e of events){if(!active(e))continue;if(typeof e.date!=='string')throw config();const dates=e.date.split(',').map(x=>x.trim());if(dates.some(d=>!date(d)))throw config();for(const d of dates){let from=Date.parse(d+'T00:00:00+08:00'),to=from+DAY;if(e.duration!=='Whole Day'){const match=typeof e.duration==='string'&&/^([0-2][0-9]:[0-5][0-9]) - ([0-2][0-9]:[0-5][0-9])$/.exec(e.duration);if(!match||!time(match[1])||!time(match[2])||match[1]===match[2])throw config();from+=minute(match[1])*60000;to=Date.parse(d+'T00:00:00+08:00')+minute(match[2])*60000;if(to<from)to+=DAY;}if(to<=begins||from>=limit)continue;const blocked=ids(e.eventTableIds),walkins=ids(e.walkInTableIds);const catering=e.caterWalkIns===undefined||e.caterWalkIns===null?null:bool(e.caterWalkIns);if(catering===false||blocked.includes(tableId)||(walkins.length&&!walkins.includes(tableId))||(!blocked.length&&!walkins.length))restrict(from,'event');}}
 let end;if(session.isOpenTime){if(session.latestEndTime!==undefined){const old=Date.parse(session.latestEndTime);if(typeof session.latestEndTime!=='string'||!Number.isFinite(old)||new Date(old).toISOString()!==session.latestEndTime||old<=start)throw config();restrict(old,'closing');}end=limit;}else{if(!Number.isSafeInteger(session.durationMinutes)||session.durationMinutes<=0||session.durationMinutes>1440)throw config();end=start+session.durationMinutes*60000;if(end<=begins||end>limit)throw conflict();}
 return{tableId,type:session.isOpenTime?'open':'fixed',latestEndTime:new Date(limit).toISOString(),limitingReason:reason,operatingDate:label(window.anchor),scope:'saved-local-policy'};
}
async function assertVenueAvailability(db,command){const [settings,closures,events,reservations]=await Promise.all([all(db,'SELECT keyName,settingValue FROM systemSettings'),all(db,'SELECT * FROM closed_dates'),all(db,'SELECT * FROM events'),all(db,'SELECT * FROM reservations')]);return evaluateVenueAvailability({settings:Object.fromEntries(settings.map(r=>[r.keyName,r.settingValue])),closures,events,reservations},command);}
module.exports={evaluateVenueAvailability,assertVenueAvailability};
