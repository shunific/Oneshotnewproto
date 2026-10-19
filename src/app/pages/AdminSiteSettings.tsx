import { localFetch } from '../utils/localApi';
import { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import {
  Save, CheckCircle, X, LayoutTemplate,
  Upload, Trash2, Image as ImageIcon, AlertTriangle
} from 'lucide-react';
import { validateCmsRecord, validateCmsSnapshot } from '../../../cms-contract.mjs';

export function AdminSiteSettings() {
  const {siteConfig,updateSiteConfig,staffProfile,pendingCmsSave,cmsSaveError,retryCmsSave,refreshCmsConfig}=useAppContext() as any;
  const [form,setForm]=useState<any>({heroImages:[],aboutImage:null});
  const [saved,setSaved]=useState<any>(null);
  const [loadedOwner,setLoadedOwner]=useState<any>(null);
  const [uploading,setUploading]=useState(false);
  const [isProcessing,setIsProcessing]=useState(false);
  const [toast,setToast]=useState<{msg:string,type:'success'|'error'}|null>(null);
  const busy=useRef(false),identity=useRef<any>(null);
  identity.current=staffProfile;
  const heroInputRef=useRef<HTMLInputElement>(null),aboutInputRef=useRef<HTMLInputElement>(null);
  const flash=(msg:string,type:'success'|'error'='success')=>setToast({msg,type});
  const currentOwner=()=>{const owner=staffProfile;if(!owner?.id||owner.isAdmin!==true||identity.current!==owner)throw new Error('Sign in as an administrator before changing local images.');return owner;};
  const remainsCurrent=(owner:any)=>identity.current===owner&&identity.current?.id===owner.id&&identity.current?.isAdmin===true;
  useEffect(()=>{
    busy.current=false;setUploading(false);setIsProcessing(false);setToast(null);setLoadedOwner(null);setSaved(null);setForm({heroImages:[],aboutImage:null});
  },[staffProfile]);
  useEffect(()=>{
    if(!staffProfile?.id||staffProfile.isAdmin!==true||!siteConfig)return;
    try{const record=validateCmsRecord(siteConfig);setSaved(record);if(loadedOwner!==staffProfile){setForm(record);setLoadedOwner(staffProfile);}}
    catch{flash('Saved image settings could not be verified. Reload the saved images before editing.','error');}
  },[siteConfig,staffProfile,loadedOwner]);
  const ownPending=pendingCmsSave?.ownerId===staffProfile?.id?pendingCmsSave:null;
  const hasHeroChanges=saved&&JSON.stringify(form.heroImages)!==JSON.stringify(saved.heroImages);
  const hasAboutImageChange=saved&&form.aboutImage!==saved.aboutImage;
  const applySection=(section:'heroImages'|'aboutImage',record:any,owner:any)=>{
    setForm((previous:any)=>remainsCurrent(owner)?{...previous,[section]:record[section]}:previous);
    setSaved((previous:any)=>remainsCurrent(owner)?{...previous,[section]:record[section]}:previous);
  };
  const saveSection=async(section:'heroImages'|'aboutImage')=>{
    if(busy.current)return;let owner;
    try{owner=currentOwner();if(ownPending||cmsSaveError)throw new Error('Resolve the saved original image request before submitting another save.');}
    catch(error:any){flash(error.message,'error');return;}
    busy.current=true;setIsProcessing(true);
    const patch={[section]:section==='heroImages'?[...form.heroImages]:form.aboutImage};
    try{const result=await updateSiteConfig(patch);if(!remainsCurrent(owner))return;const snapshot=validateCmsSnapshot({record:result.record,revision:result.revision});applySection(section,snapshot.record,owner);flash(result.superseded?'Original save confirmed locally. A later saved version is retained; review the displayed images.':'Image settings saved on this POS. Hosted publishing is separate.');}
    catch(error:any){if(remainsCurrent(owner))flash(error?.message||'Image settings save is unconfirmed. Your draft is kept.','error');}
    finally{if(remainsCurrent(owner)){busy.current=false;setIsProcessing(false);}}
  };
  const saveHeroImages=()=>saveSection('heroImages');
  const saveAboutImage=()=>saveSection('aboutImage');
  const recoverOriginal=async()=>{
    if(busy.current||!ownPending)return;let owner;try{owner=currentOwner();}catch(error:any){flash(error.message,'error');return;}const sections=Object.keys(ownPending.command.patch) as ('heroImages'|'aboutImage')[];
    busy.current=true;setIsProcessing(true);
    try{const result=await retryCmsSave();if(!remainsCurrent(owner))return;const snapshot=validateCmsSnapshot({record:result.record,revision:result.revision});if(loadedOwner!==owner||!saved){setForm(snapshot.record);setSaved(snapshot.record);setLoadedOwner(owner);}else for(const section of sections)applySection(section,snapshot.record,owner);flash(result.superseded?'Original save confirmed locally. A later saved version is retained; review the displayed images.':'Original image save confirmed on this POS. Hosted publishing is separate.');}
    catch(error:any){if(remainsCurrent(owner))flash(error?.message||'Original image save remains unconfirmed.','error');}
    finally{if(remainsCurrent(owner)){busy.current=false;setIsProcessing(false);}}
  };
  const reloadSection=async(section:'heroImages'|'aboutImage')=>{
    if(busy.current)return;let owner;try{owner=currentOwner();}catch(error:any){flash(error.message,'error');return;}
    busy.current=true;setIsProcessing(true);
    try{const snapshot=validateCmsSnapshot(await refreshCmsConfig());if(!remainsCurrent(owner))return;if(loadedOwner!==owner||!saved){setForm(snapshot.record);setSaved(snapshot.record);}else applySection(section,snapshot.record,owner);setLoadedOwner(owner);flash('Selected image section reloaded from this POS. Other draft changes are kept.');}
    catch(error:any){if(remainsCurrent(owner))flash(error?.message||'Saved image reload failed. Your draft is kept.','error');}
    finally{if(remainsCurrent(owner)){busy.current=false;setIsProcessing(false);}}
  };
  const handleImageUpload=async(e:React.ChangeEvent<HTMLInputElement>,target:'hero'|'about')=>{
    const input=e.target,files=Array.from(input.files||[]);if(!files.length||busy.current)return;let owner;
    try{
      owner=currentOwner();
      if(files.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size<=0||file.size>5*1024*1024))throw new Error('Choose PNG, JPEG or WebP images, each 5 MiB or smaller.');
      if(target==='about'&&files.length!==1)throw new Error('Choose one featured image.');
      if(target==='hero'&&form.heroImages.length+files.length>5)throw new Error('The gallery can contain at most five images.');
    }catch(error:any){flash(error.message,'error');input.value='';return;}
    if(target==='about'&&form.aboutImage&&!window.confirm('Replace the draft featured image on this POS?')){input.value='';return;}
    busy.current=true;setUploading(true);
    try{
      const urls=[];
      for(const file of files){const data=new FormData();data.append('image',file);const response=await localFetch('/api/images',{method:'POST',body:data});if(!response.ok)throw new Error('Image upload could not be confirmed. Existing draft images are kept.');const result=await response.json();if(!remainsCurrent(owner))return;if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).length!==1||typeof result.url!=='string'||!/^\/api\/images\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.url))throw new Error('The uploaded local image address could not be verified.');urls.push(result.url);}
      if(!remainsCurrent(owner))return;
      setForm((previous:any)=>!remainsCurrent(owner)?previous:target==='hero'?{...previous,heroImages:[...previous.heroImages,...urls]}:{...previous,aboutImage:urls[0]});
      flash('Images uploaded to this POS. Use Update to save the selected section.');
    }catch(error:any){if(remainsCurrent(owner))flash(error?.message||'Local image upload failed.','error');}
    finally{input.value='';if(remainsCurrent(owner)){busy.current=false;setUploading(false);}}
  };
  const removeHeroImage=(index:number)=>{
    if(busy.current||!window.confirm('Remove this image from the draft gallery on this POS?'))return;
    setForm((previous:any)=>({...previous,heroImages:previous.heroImages.filter((_:string,i:number)=>i!==index)}));
  };
  const recoveryControls = (ownPending||cmsSaveError)&&<div role="alert" className="rounded-xl border border-amber-700 p-4 text-sm text-amber-200">
        <p>{cmsSaveError||'An original image save needs confirmation. Retry it before saving another change.'}</p>
        {ownPending&&<><p className="mt-2">Original sections: {Object.keys(ownPending.command.patch).join(', ')}</p><ul className="break-all text-xs">{[...(ownPending.command.patch.heroImages||[]),...(ownPending.command.patch.aboutImage?[ownPending.command.patch.aboutImage]:[])].map((url:string,index:number)=><li key={index}>{url}</li>)}</ul><button type="button" disabled={isProcessing||uploading} onClick={recoverOriginal} className="mt-2 underline">Retry original image save</button></>}
      </div>;
  if(loadedOwner!==staffProfile||!saved)return <div className="space-y-3">{recoveryControls}<p>Saved local image settings are not loaded.</p><button onClick={()=>reloadSection('heroImages')}>Reload saved gallery</button><button onClick={()=>reloadSection('aboutImage')}>Reload saved featured image</button>{toast&&<p role="alert">{toast.msg}</p>}</div>;

  return (
    <div className="space-y-6 max-w-4xl relative pb-10">
      {/* 🟢 FULL SCREEN SPINNER TO BLOCK INPUTS */}
      {isProcessing && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-4 bg-neutral-950 p-8 rounded-2xl border border-neutral-800 shadow-2xl">
            <div className="w-12 h-12 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin"></div>
            <p className="text-xs font-bold text-sky-400 uppercase tracking-widest animate-pulse">Saving local changes…</p>
          </div>
        </div>
      )}

      {/* 🟢 TOP-RIGHT FLOATING TOAST WITH 5S TIMER & FADE OUT */}
      {toast && (
        <div
          className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300"
          style={{ animation: 'toast-fade-out 5s forwards' }}
        >
          <div className={`relative overflow-hidden flex items-start gap-3 px-5 py-4 rounded-xl border shadow-2xl backdrop-blur-md min-w-[320px] max-w-md ${
            toast.type === 'success'
              ? 'bg-sky-950/90 border-sky-900/50 text-sky-400'
              : 'bg-rose-950/90 border-rose-900/50 text-rose-400'
          }`}>
            <div className="mt-0.5 flex-shrink-0">
              {toast.type === 'success' ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
            </div>
            <span className="text-sm font-semibold leading-snug whitespace-pre-wrap pr-4">{toast.msg}</span>
            <button
              onClick={() => setToast(null)}
              className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
            <div
              className={`absolute bottom-0 left-0 h-1 ${toast.type === 'success' ? 'bg-sky-500' : 'bg-rose-500'}`}
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

      <div className="bg-sky-950/20 border border-sky-900/30 rounded-xl p-4 flex items-start gap-3">
        <LayoutTemplate size={15} className="text-sky-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-sky-400/80 leading-relaxed">
          <strong>Local image settings:</strong> Homepage text is fixed. Manage the gallery and featured image saved on this POS. Hosted website publishing is separate.
        </p>
      </div>

      <div className="space-y-6 animate-in fade-in duration-300">

        {recoveryControls}
      {/* HERO GALLERY SECTION */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5 flex flex-col">
          <div className="flex justify-between items-center border-b border-neutral-800 pb-3 mb-4">
            <h3 className="text-xs text-neutral-500 uppercase tracking-widest font-semibold">Slider Gallery</h3>
            <div className="flex items-center gap-3">
              <span className="text-[10px] bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded-md">{(Array.isArray(form.heroImages) ? form.heroImages : []).length}/5 Uploaded</span>
              <button
                type="button"
                onClick={saveHeroImages}
                disabled={!hasHeroChanges || isProcessing || uploading || !!ownPending || !!cmsSaveError}
                className="bg-sky-600 hover:bg-sky-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-semibold flex items-center gap-1.5 transition-colors shadow-lg shadow-sky-900/20"
              >
                <Save size={14} /> Update Gallery
              </button>
              <button type="button" disabled={isProcessing||uploading} onClick={()=>reloadSection('heroImages')} className="text-xs underline">Reload saved gallery</button>
            </div>
          </div>

          <div className="flex overflow-x-auto gap-3 pb-2 mb-4 flex-1 hide-scrollbar">
            {(Array.isArray(form.heroImages) ? form.heroImages : []).map((imgUrl: string, idx: number) => (
              <div key={idx} className="relative h-32 w-48 flex-shrink-0 rounded-lg overflow-hidden border border-neutral-700 group bg-neutral-900">
                <img src={imgUrl} alt={`Hero ${idx + 1}`} className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button type="button" disabled={uploading || isProcessing} onClick={() => removeHeroImage(idx)} className="p-2 bg-rose-600 hover:bg-rose-500 text-white rounded-full transition-colors shadow-lg">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}

            {(Array.isArray(form.heroImages) ? form.heroImages : []).length < 5 && (
              <button type="button" disabled={uploading || isProcessing} onClick={() => heroInputRef.current?.click()} className="h-32 w-48 flex-shrink-0 rounded-lg border-2 border-dashed border-neutral-700 hover:border-sky-500/50 bg-neutral-900/50 flex flex-col items-center justify-center gap-1.5 transition-colors text-neutral-500 hover:text-sky-400 disabled:opacity-50 cursor-pointer">
                <Upload size={16} />
                <span className="text-[10px] font-semibold">{uploading ? 'Uploading...' : 'Upload Image'}</span>
              </button>
            )}
          </div>

          <input type="file" ref={heroInputRef} accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => handleImageUpload(e, 'hero')} />
        </div>

        {/* ABOUT US IMAGE SECTION */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5">
          <div className="flex justify-between items-center border-b border-neutral-800 pb-3 mb-4">
            <h3 className="text-xs text-neutral-500 uppercase tracking-widest font-semibold">About Featured Image</h3>
            <button
              type="button"
              onClick={saveAboutImage}
              disabled={!hasAboutImageChange || isProcessing || uploading || !!ownPending || !!cmsSaveError}
              className="bg-sky-600 hover:bg-sky-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-semibold flex items-center gap-1.5 transition-colors shadow-lg shadow-sky-900/20"
            >
              <Save size={14} /> Update Image
            </button>
            <button type="button" disabled={isProcessing||uploading} onClick={()=>reloadSection('aboutImage')} className="text-xs underline">Reload saved featured image</button>
          </div>
          <p className="text-[10px] text-neutral-500 mb-4">Upload the feature image shown next to the hardcoded "About Us" text.</p>

          <div className="relative h-64 rounded-xl overflow-hidden border border-neutral-700 group bg-neutral-900 flex items-center justify-center max-w-2xl">
            {form.aboutImage ? (
              <>
                <img src={form.aboutImage} alt="About Us Feature" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3">
                  <button type="button" disabled={uploading || isProcessing} onClick={() => aboutInputRef.current?.click()} className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors disabled:opacity-50">
                    <ImageIcon size={14} /> {uploading ? 'Uploading...' : 'Change Image'}
                  </button>
                </div>
              </>
            ) : (
              <button type="button" disabled={uploading || isProcessing} onClick={() => aboutInputRef.current?.click()} className="flex flex-col items-center justify-center gap-2 text-neutral-500 hover:text-sky-400 transition-colors w-full h-full disabled:opacity-50">
                <Upload size={24} />
                <span className="text-xs font-semibold">{uploading ? 'Uploading...' : 'Upload Feature Image'}</span>
              </button>
            )}
          </div>
          <input type="file" ref={aboutInputRef} accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => handleImageUpload(e, 'about')} />
        </div>

      </div>
    </div>
  );
}
