const cents=value=>{
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||!Number.isSafeInteger(Math.round(value*100))||Math.abs(value*100-Math.round(value*100))>0.000001)throw new Error('Saved receipt amounts need review.');
 return Math.round(value*100);
};
const timestamp=value=>{if(value===null||value===undefined||value==='')throw new Error('Receipt identity could not be verified.');const time=new Date(value).getTime();if(!Number.isFinite(time))throw new Error('Receipt identity could not be verified.');return time;};
export function projectHistoryReceipt(record,receipt){
 if(!record||record.source!=='table_session'||!receipt||receipt.id!==record.id||receipt.table_id!==record.tableId||receipt.customer_name!==record.customerName||timestamp(receipt.play_start_time)!==timestamp(record.startTime)||timestamp(receipt.play_end_time)!==timestamp(record.endTime))throw new Error('Saved receipt does not match this session.');
 const durationMinutes=receipt.duration_minutes===null||receipt.duration_minutes===undefined?null:receipt.duration_minutes;
 if(durationMinutes!==null&&(!Number.isSafeInteger(durationMinutes)||durationMinutes<0))throw new Error('Saved receipt duration needs review.');
 const names=['table_charge','overtime_charge','fnb_charge','subtotal','discount_amount','total_amount','amount_paid','balance_due'];const amounts=Object.fromEntries(names.map(name=>[name,cents(receipt[name])]));
 if(!Number.isSafeInteger(amounts.table_charge+amounts.overtime_charge+amounts.fnb_charge)||amounts.table_charge+amounts.overtime_charge+amounts.fnb_charge!==amounts.subtotal||amounts.discount_amount>amounts.subtotal||amounts.subtotal-amounts.discount_amount!==amounts.total_amount||amounts.amount_paid+amounts.balance_due!==amounts.total_amount)throw new Error('Saved receipt totals need review.');
 const refund=receipt.refund_due===undefined||receipt.refund_due===null?null:cents(receipt.refund_due);
 if(refund!==null&&!['none','pending','returned'].includes(receipt.refund_status))throw new Error('Saved return status needs review.');
 if(refund!==null&&((refund===0&&receipt.refund_status!=='none')||(refund>0&&!['pending','returned'].includes(receipt.refund_status))))throw new Error('Saved return status needs review.');
 let itemTotal=0,items=[];
 try{if(!Array.isArray(record.orders))throw Error();items=record.orders.map(order=>{if(typeof order.name!=='string'||!order.name.trim()||!Number.isSafeInteger(order.qty)||order.qty<=0)throw Error();const unit=cents(order.price);if(!Number.isSafeInteger(unit*order.qty)||!Number.isSafeInteger(itemTotal+unit*order.qty))throw Error();itemTotal+=unit*order.qty;return{name:order.name,qty:order.qty,unitCents:unit,totalCents:unit*order.qty};});if(itemTotal!==amounts.fnb_charge)items=[];}catch{items=[];}
 const isVoided=['voided','voided_refund_pending'].includes(receipt.payment_status);
 return{startTime:receipt.play_start_time,endTime:receipt.play_end_time,durationMinutes,customerName:receipt.customer_name,receiptNo:receipt.receipt_no||receipt.id,tableName:receipt.table_name||record.tableName,amounts,items,refundCents:refund,refundStatus:refund===null?null:receipt.refund_status,paymentStatus:receipt.payment_status,isVoided,voidReason:isVoided&&typeof receipt.void_reason==='string'?receipt.void_reason:null};
}
