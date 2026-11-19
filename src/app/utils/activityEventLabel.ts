export function activityEventLabel(type: string) {
  return type === 'pos_order' ? 'table order' : type.replace(/_/g, ' ');
}
