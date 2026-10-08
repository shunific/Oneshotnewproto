import { useState, useMemo, useRef } from 'react';
import { useAppContext, ActivityType } from '../context/AppContext';
import { 
  PlusCircle, XCircle, RefreshCw, Info, FileText, 
  LayoutGrid, ShoppingCart, CalendarDays, Users, ShieldCheck, Tag,
  CheckCircle, AlertTriangle, X
} from 'lucide-react';
import { isToday, isYesterday, isThisWeek, isThisMonth, isWithinInterval, startOfDay, endOfDay } from 'date-fns';

export function ActivityLog() {
  // 🟢 FIXED: Grabbed the theme from context for dynamic calendar/clock icons
  const { activities, theme } = useAppContext();
  
  const [dateFilter, setDateFilter] = useState<string>('ALL');
  const [moduleFilter, setModuleFilter] = useState<string>('ALL');
  const [actorFilter, setActorFilter] = useState<string>('ALL');
  const [eventFilter, setEventFilter] = useState<string>('ALL');
  
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const categoryMap: Record<string, ActivityType[]> = {
    'Table Management': ['table_assigned', 'table_freed', 'table_reserved', 'session_extended'],
    'Point of Sale': ['pos_order', 'payment_received'],
    'Reservations': ['reservation_created', 'reservation_updated', 'reservation_cancelled'],
    'Queue System': ['queue_added', 'queue_removed', 'queue_called'],
    'System Actions': ['admin_action', 'tako_action', 'promo_created'],
  };

  const getActor = (description: string) => {
    const match = description.match(/\(Action by:\s*(.*?)\)/);
    return match ? match[1] : 'System';
  };

  const cleanDescription = (desc: string) => desc.replace(/\s*\(Action by:.*?\)/, '');

  const getModule = (type: string) => {
    for (const [cat, types] of Object.entries(categoryMap)) {
      if (types.includes(type as any)) return cat;
    }
    return 'System Actions';
  };

  const getModuleIcon = (moduleName: string) => {
    switch (moduleName) {
      case 'Table Management': return <LayoutGrid size={12} className="text-blue-400" />;
      case 'Point of Sale': return <ShoppingCart size={12} className="text-emerald-400" />;
      case 'Reservations': return <CalendarDays size={12} className="text-purple-400" />;
      case 'Queue System': return <Users size={12} className="text-emerald-400" />;
      default: return <ShieldCheck size={12} className="text-rose-400" />;
    }
  };

  const getEventUI = (type: string) => {
    const formattedText = type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    if (type.includes('created') || type.includes('added') || type === 'pos_order' || type.includes('received')) {
      return { icon: <PlusCircle size={14} className="text-emerald-500" />, text: formattedText };
    }
    if (type.includes('removed') || type.includes('freed') || type.includes('cancelled') || type.includes('deleted')) {
      return { icon: <XCircle size={14} className="text-rose-500" />, text: formattedText };
    }
    if (type.includes('updated') || type.includes('extended') || type.includes('changed') || type.includes('toggled') || type.includes('called') || type.includes('assigned')) {
      return { icon: <RefreshCw size={14} className="text-blue-500" />, text: formattedText };
    }
    return { icon: <Info size={14} className="text-emerald-500" />, text: formattedText };
  };

  // 🟢 TOAST STATE
  const [toast, setToast] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);

  const flash = (msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast({ msg, type });
    toastTimeout.current = setTimeout(() => setToast(null), 5000); // 5 seconds
  };

  // 🟢 CREATE REPORT (CSV DOWNLOAD)
  // 🟢 CREATE REPORT (UPGRADED TO EXCEL .XLS SPREADSHEET WITH AUTO-SIZING COLUMNS)
  const handleCreateReport = () => {
    if (filteredActivities.length === 0) {
      flash("No activities found for the selected period to generate a report.", "error");
      return;
    }

    try {
      const headers = ['Date', 'Module', 'Employee', 'Event', 'Details'];
      
      // 1. Prepare and clean data rows
      const dataRows = filteredActivities.map(act => {
        const dateObj = new Date(act.timestamp);
        // Using a cleaner format: YYYY-MM-DD HH:MM AM/PM
        const formattedDate = `${dateObj.toLocaleDateString()} ${dateObj.toLocaleTimeString()}`;
        const module = getModule(act.type);
        const actor = getActor(act.description);
        const event = act.type.replace(/_/g, ' ');
        const details = cleanDescription(act.description);
        
        return [formattedDate, module, actor, event, details];
      });

      // 2. Dynamically calculate optimal column widths based on text length
      const colWidths = headers.map((header, colIndex) => {
        let maxLength = header.length;
        dataRows.forEach(row => {
          if (row[colIndex] && row[colIndex].length > maxLength) {
            maxLength = row[colIndex].length;
          }
        });
        // Multiply by ~7.5 pixels per character, add 15px padding, cap max width at 400px so long descriptions don't break the screen
        return Math.min(maxLength * 7.5 + 15, 400); 
      });

      // 3. Build Native Excel XML (SpreadsheetML)
      let xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="sHeader">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#eeeeee" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Activity Report">
  <Table>`;

      // Inject the calculated column widths
      colWidths.forEach(w => {
        xml += `\n   <Column ss:Width="${w}"/>`;
      });

      // Inject Headers
      xml += `\n   <Row>`;
      headers.forEach(h => {
        xml += `\n    <Cell ss:StyleID="sHeader"><Data ss:Type="String">${h}</Data></Cell>`;
      });
      xml += `\n   </Row>`;

      // Inject Data Rows
      dataRows.forEach(row => {
        xml += `\n   <Row>`;
        row.forEach(cell => {
          // Escape XML special characters so random characters in descriptions don't corrupt the file
          const escapedCell = String(cell)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
            
          // ss:Type="String" forces Excel to read the Date as text, permanently preventing the ######## error
          xml += `\n    <Cell><Data ss:Type="String">${escapedCell}</Data></Cell>`;
        });
        xml += `\n   </Row>`;
      });

      xml += `\n  </Table>\n </Worksheet>\n</Workbook>`;

      // 4. Trigger Download
      const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      
      link.setAttribute('href', url);
      link.setAttribute('download', `activity_report_${new Date().toISOString().slice(0, 10)}.xls`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      flash("Activity report generated and downloaded successfully!", "success");
    } catch (error) {
      flash("An error occurred while generating the report.", "error");
    }
  };

  const uniqueActors = useMemo(() => Array.from(new Set(activities.map(a => getActor(a.description)))).sort(), [activities]);
  const uniqueEvents = useMemo(() => Array.from(new Set(activities.map(a => a.type))).sort(), [activities]);

  const filteredActivities = activities.filter(a => {
    const actDate = new Date(a.timestamp);
    if (dateFilter === 'TODAY' && !isToday(actDate)) return false;
    if (dateFilter === 'YESTERDAY' && !isYesterday(actDate)) return false;
    if (dateFilter === 'THIS_WEEK' && !isThisWeek(actDate)) return false;
    if (dateFilter === 'THIS_MONTH' && !isThisMonth(actDate)) return false;
    if (dateFilter === 'CUSTOM') {
      if (startDate && endDate && !isWithinInterval(actDate, { start: startOfDay(new Date(startDate)), end: endOfDay(new Date(endDate)) })) return false;
    }
    if (moduleFilter !== 'ALL' && getModule(a.type) !== moduleFilter) return false;
    if (actorFilter !== 'ALL' && getActor(a.description) !== actorFilter) return false;
    if (eventFilter !== 'ALL' && a.type !== eventFilter) return false;
    return true;
  });

  return (
    <div className="max-w-7xl mx-auto space-y-6">
    {/* 🟢 TOP-RIGHT FLOATING TOAST WITH 5S TIMER & FADE OUT */}
      {toast && (
        <div 
          className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300"
          style={{ animation: 'toast-fade-out 5s forwards' }}
        >
          <div className={`relative overflow-hidden flex items-start gap-3 px-5 py-4 rounded-xl border shadow-2xl backdrop-blur-md min-w-[320px] max-w-md ${
            toast.type === 'success' 
              ? 'bg-emerald-950/90 border-emerald-900/50 text-emerald-400' 
              : 'bg-rose-950/90 border-rose-900/50 text-rose-400'
          }`}>
            <div className="mt-0.5 flex-shrink-0">
              {toast.type === 'success' ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
            </div>
            <span className="text-sm font-semibold leading-snug whitespace-pre-wrap pr-4">{toast.msg}</span>
            <button 
              onClick={() => { setToast(null); if (toastTimeout.current) clearTimeout(toastTimeout.current); }} 
              className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
            <div 
              className={`absolute bottom-0 left-0 h-1 ${toast.type === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}`}
              style={{ animation: 'toast-shrink 5s linear forwards' }}
            />
          </div>
          <style>{`
            @keyframes toast-shrink {
              0% { width: 100%; }
              100% { width: 0%; }
            }
            @keyframes toast-fade-out {
              0%, 90% { opacity: 1; transform: translateY(0); }
              100% { opacity: 0; transform: translateY(-10px); }
            }
          `}</style>
        </div>
      )}
      <div>
        <h2 className="text-2xl font-black text-neutral-100 tracking-tight">Activity log</h2>
        <p className="text-sm text-neutral-500 mt-1">List of all events in the system account.</p>
      </div>

      <div className="flex flex-col xl:flex-row items-end xl:items-center justify-between gap-4 w-full">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full xl:w-auto flex-1">
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-neutral-500 tracking-wider">Period</label>
            <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors">
              <option value="ALL">All time</option>
              <option value="TODAY">Today</option>
              <option value="YESTERDAY">Yesterday</option>
              <option value="THIS_WEEK">This Week</option>
              <option value="THIS_MONTH">This Month</option>
              <option value="CUSTOM">Custom Range...</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-neutral-500 tracking-wider">Module</label>
            <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors">
              <option value="ALL">All modules</option>
              {Object.keys(categoryMap).map(cat => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-neutral-500 tracking-wider">Employee</label>
            <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)} className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors">
              <option value="ALL">All employees</option>
              {uniqueActors.map(actor => <option key={actor} value={actor}>{actor}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-neutral-500 tracking-wider">Events</label>
            <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-lg text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors">
              <option value="ALL">All events</option>
              {uniqueEvents.map(evt => <option key={evt} value={evt}>{evt.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
        </div>
        {/* 🟢 FIXED: Hardcoded blue colors mapped to Emerald Theme */}
        <button 
          onClick={handleCreateReport}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-neutral-100 text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors h-[42px] whitespace-nowrap shadow-lg shadow-emerald-900/20"
        >
          <FileText size={16} /> Create report
        </button>
      </div>

      {dateFilter === 'CUSTOM' && (
        <div className="flex items-center gap-3 bg-neutral-900/30 p-3 rounded-lg border border-neutral-800 animate-in fade-in">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} className="bg-neutral-900 border border-neutral-800 rounded flex-1 px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500 transition-colors" />
          <span className="text-neutral-500 text-sm">—</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} className="bg-neutral-900 border border-neutral-800 rounded flex-1 px-3 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500 transition-colors" />
        </div>
      )}

      {/* 🟢 FIXED: Removed hardcoded bg-[#121212] and bg-[#1e1e1e] */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-lg overflow-x-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-neutral-900 text-neutral-400 font-semibold border-b border-neutral-800">
            <tr>
              <th className="px-5 py-3.5 font-medium min-w-[160px]">Date and time</th>
              <th className="px-5 py-3.5 font-medium min-w-[180px]">Module</th>
              <th className="px-5 py-3.5 font-medium min-w-[140px]">Employee</th>
              <th className="px-5 py-3.5 font-medium min-w-[200px]">Event</th>
              <th className="px-5 py-3.5 font-medium w-full">Additional Details</th>
            </tr>
          </thead>
          
          <tbody className="divide-y divide-neutral-800/50">
            {filteredActivities.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-neutral-500">
                  <p className="font-semibold">No activity found for this period.</p>
                </td>
              </tr>
            ) : (
              filteredActivities.map((act) => {
                const dateObj = new Date(act.timestamp);
                const formattedDate = `${dateObj.getDate().toString().padStart(2, '0')} ${dateObj.toLocaleString('default', { month: 'short' })} ${dateObj.getFullYear()} ${dateObj.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
                const moduleName = getModule(act.type);
                const eventUI = getEventUI(act.type);
                const cleanDesc = cleanDescription(act.description);

                return (
                  <tr key={act.id} className="hover:bg-neutral-900 transition-colors group">
                    <td className="px-5 py-3.5 text-neutral-300">{formattedDate}</td>
                    <td className="px-5 py-3.5 text-neutral-400">
                      <div className="flex items-center gap-2">
                        <div className="p-1 rounded bg-neutral-800 border border-neutral-700">
                           {getModuleIcon(moduleName)}
                        </div>
                        {moduleName}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-neutral-300">{getActor(act.description)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2 text-neutral-300 font-medium">
                        {eventUI.icon}
                        {eventUI.text}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-neutral-400 whitespace-normal min-w-[300px]">{cleanDesc}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        
        <div className="px-5 py-4 border-t border-neutral-800 bg-neutral-900 text-xs font-semibold text-neutral-400">
          Total — {filteredActivities.length}
        </div>
      </div>
    </div>
  );
}