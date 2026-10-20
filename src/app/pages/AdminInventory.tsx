import { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { 
  PackageSearch, Plus, Search, Edit2, Trash2, X, AlertTriangle, 
  ShoppingCart, Tag, Hash, Archive, List 
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';

type InventoryForm = {
  name: string;
  category: string;
  price: string;
  stock: string;
};

const emptyForm: InventoryForm = { name: '', category: 'Drinks', price: '', stock: '' };

export function AdminInventory() {
  const { inventory, addInventoryItem, updateInventoryItem, deleteInventoryItem } = useAppContext();
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('All');
  
  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingStock, setEditingStock] = useState<number | null>(null);
  const [form, setForm] = useState<InventoryForm>(emptyForm);

  // Quick Restock State
  const [restockId, setRestockId] = useState<string | null>(null);
  const [restockAmount, setRestockAmount] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const categories = ['All', ...Array.from(new Set(inventory.map(i => i.category)))];

  const filtered = inventory.filter(i => {
    const matchesSearch = i.name.toLowerCase().includes(search.toLowerCase());
    const matchesCat = filterCat === 'All' || i.category === filterCat;
    return matchesSearch && matchesCat;
  });

  const openCreate = () => {
    setError('');
    setEditingId(null);
    setEditingStock(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (item: any) => {
    setError('');
    setEditingId(item.id);
    setEditingStock(item.stock);
    setForm({
      name: item.name,
      category: item.category,
      price: item.price.toString(),
      stock: item.stock.toString(),
    });
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setError('');
    const price = Number(form.price);
    const stock = Number(form.stock);
    if (!form.name.trim() || !form.price.trim() || !form.stock.trim() || !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(stock) || stock < 0) {
      setError('Enter an item name, a nonnegative price, and a whole stock quantity.');
      return;
    }
    const payload = {
      name: form.name.trim(), category: form.category, price, stock,
      isActive: editingId ? inventory.find(item => item.id === editingId)?.isActive ?? true : true,
    };
    setIsSaving(true);
    try {
      if (editingId) {
        if (editingStock === null) throw new Error('Opening stock is unavailable');
        await updateInventoryItem(editingId, payload, editingStock);
      }
      else await addInventoryItem(payload);
      setShowModal(false);
    } catch {
      setError('Unable to save inventory. Your changes are still here. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRestock = async (e: React.FormEvent, itemId: string, currentStock: number) => {
    e.preventDefault();
    if (isSaving) return;
    setError('');
    const add = Number(restockAmount);
    if (!Number.isSafeInteger(add) || add <= 0 || !Number.isSafeInteger(currentStock + add)) {
      setError('Enter a positive whole restock quantity.');
      return;
    }
    setIsSaving(true);
    try {
      await updateInventoryItem(itemId, { stock: currentStock + add }, currentStock);
      setRestockId(null);
      setRestockAmount('');
    } catch {
      setError('Unable to restock this item. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleItemAction = async (itemId: string, isActive?: boolean) => {
    if (isSaving) return;
    setError('');
    setIsSaving(true);
    try {
      if (isActive === undefined) await deleteInventoryItem(itemId);
      else await updateInventoryItem(itemId, { isActive });
    } catch {
      setError('Unable to update inventory. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div>
          <h2 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
            <PackageSearch className="text-emerald-500" size={24} />
            Inventory & POS Menu
          </h2>
          <p className="text-xs text-neutral-400 mt-1">Manage food, drinks, and extras available at the Point of Sale.</p>
        </div>
        <button disabled={isSaving} onClick={openCreate} className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-emerald-900/20">
          <Plus size={16} /> Add Item
        </button>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 bg-neutral-950 p-4 rounded-xl border border-neutral-800">
        <div className="relative flex-1 w-full">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input type="text" placeholder="Search items..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full bg-neutral-900 border border-neutral-800 rounded-lg pl-9 pr-4 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40" />
        </div>
        <div className="flex gap-2 flex-wrap">
          {categories.map(cat => (
            <button key={cat} onClick={() => setFilterCat(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${filterCat === cat ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-neutral-900 text-neutral-500 border-neutral-800 hover:border-neutral-700'}`}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {error && !showModal && <p role="alert" className="text-sm text-rose-400">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map(item => {
          const outOfStock = item.stock <= 0;
          const lowStock = item.stock > 0 && item.stock <= 5;
          
          return (
            <Card key={item.id} className={`bg-neutral-900 overflow-hidden flex flex-col ${outOfStock ? 'border-rose-900/50' : lowStock ? 'border-amber-900/50' : 'border-neutral-800'}`}>
              <CardContent className="p-5 flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <span className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold">{item.category}</span>
                      <h3 className={`text-lg font-bold ${outOfStock ? 'text-neutral-500' : 'text-neutral-200'}`}>{item.name}</h3>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-black text-emerald-400">₱{item.price.toFixed(2)}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2 mt-4">
                    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-semibold ${
                      outOfStock ? 'bg-rose-950/40 border-rose-800/50 text-rose-400' : 
                      lowStock ? 'bg-amber-950/40 border-amber-800/50 text-amber-400' : 
                      'bg-neutral-950 border-neutral-800 text-neutral-400'
                    }`}>
                      <Archive size={12} /> Stock: {item.stock}{!item.isActive && ' · Archived'}
                    </div>
                    {outOfStock && <span className="text-[10px] font-bold text-rose-500 uppercase tracking-wider flex items-center gap-1"><AlertTriangle size={10}/> Out of Stock</span>}
                  </div>
                </div>

                <div className="mt-5 flex gap-2">
                  {restockId === item.id ? (
                    <form onSubmit={(e) => handleRestock(e, item.id, item.stock)} className="flex-1 flex gap-1">
                      <input type="number" min="1" required autoFocus value={restockAmount} onChange={e => setRestockAmount(e.target.value)} placeholder="+ Add qty" className="w-20 bg-neutral-950 border border-neutral-700 rounded-lg px-2 text-xs text-white outline-none focus:border-emerald-500" />
                      <button disabled={isSaving} type="submit" className="bg-emerald-600 text-white px-2 py-1.5 rounded-lg text-[10px] font-bold">Save</button>
                      <button disabled={isSaving} type="button" onClick={() => setRestockId(null)} className="bg-neutral-800 text-neutral-400 px-2 py-1.5 rounded-lg text-[10px] font-bold">Cancel</button>
                    </form>
                  ) : (
                    <>
                      <button disabled={isSaving} onClick={() => { setError(''); setRestockId(item.id); }} className="flex-1 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs rounded-lg font-semibold transition-colors">Quick Restock</button>
                      <button disabled={isSaving} onClick={() => handleItemAction(item.id, !item.isActive)} className="px-2 py-1.5 bg-neutral-800 text-neutral-300 text-xs rounded-lg">{item.isActive ? 'Archive' : 'Restore'}</button>
                      <button disabled={isSaving} onClick={() => openEdit(item)} className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-blue-400 rounded-lg transition-colors"><Edit2 size={14} /></button>
                      <button disabled={isSaving} onClick={() => handleItemAction(item.id)} className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-rose-400 rounded-lg transition-colors"><Trash2 size={14} /></button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-full py-12 text-center border-2 border-dashed border-neutral-800 rounded-xl">
            <ShoppingCart size={32} className="mx-auto text-neutral-600 mb-3" />
            <p className="text-neutral-400 font-medium">No items found</p>
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center">
              <div>
                <h3 className="font-bold text-neutral-200">{editingId ? 'Edit Item' : 'New Inventory Item'}</h3>
              </div>
              <button disabled={isSaving} onClick={() => setShowModal(false)} className="p-1.5 text-neutral-500 hover:text-white rounded-lg transition-colors"><X size={15}/></button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
              <div>
                <label className="text-xs font-semibold text-neutral-400 block mb-1.5 flex items-center gap-1.5"><Tag size={11} /> Item Name</label>
                <input required autoFocus value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. San Mig Light" className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50" />
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-400 block mb-1.5 flex items-center gap-1.5"><List size={11} /> Category</label>
                <select value={form.category} onChange={e => setForm({...form, category: e.target.value})} className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50">
                  <option>Drinks</option>
                  <option>Food</option>
                  <option>Extras</option>
                  <option>Merchandise</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-neutral-400 block mb-1.5">Price (PHP)</label>
                  <input required type="number" min="0" step="0.01" value={form.price} onChange={e => setForm({...form, price: e.target.value})} placeholder="0.00" className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-neutral-400 block mb-1.5 flex items-center gap-1.5"><Hash size={11} /> Initial Stock</label>
                  <input required type="number" min="0" value={form.stock} onChange={e => setForm({...form, stock: e.target.value})} placeholder="e.g. 24" className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50" />
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button disabled={isSaving} type="button" onClick={() => setShowModal(false)} className="px-4 py-2.5 bg-neutral-800 text-neutral-300 text-sm rounded-xl">Cancel</button>
                <button disabled={isSaving} type="submit" className="flex-1 bg-emerald-600 text-white text-sm rounded-xl font-semibold py-2.5">Save Item</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}