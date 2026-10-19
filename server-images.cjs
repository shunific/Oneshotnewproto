const multer = require('multer');
const { randomUUID } = require('node:crypto');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Accept simple legacy database IDs as well as newly generated UUIDs.
const imageId = /^[a-zA-Z0-9_-]{1,120}$/;
function imageMime(data) {
  if (!Buffer.isBuffer(data) || data.length > MAX_IMAGE_BYTES) return null;
  if (data.length >= 45 && data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && data.toString('ascii',12,16)==='IHDR' && data.readUInt32BE(16)>0 && data.readUInt32BE(20)>0 && data.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex'))) return 'image/png';
  if (data.length >= 4 && data[0]===0xff && data[1]===0xd8 && data[2]===0xff && data[data.length-2]===0xff && data[data.length-1]===0xd9) return 'image/jpeg';
  if (data.length >= 20 && data.toString('ascii',0,4)==='RIFF' && data.readUInt32LE(4)===data.length-8 && data.toString('ascii',8,12)==='WEBP' && ['VP8 ','VP8L','VP8X'].includes(data.toString('ascii',12,16))) return 'image/webp';
  return null;
}
function registerImageRoutes(app,db,{requireAuth}={}) {
  const guards=Array.isArray(requireAuth)?requireAuth:[requireAuth];
  if (!guards.length || !guards.every(g=>typeof g==='function')) throw TypeError('Image routes require local authentication.');
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_IMAGE_BYTES,files:1,fields:0,parts:2}}).single('image');
  app.post('/api/images',...guards,(req,res)=>upload(req,res,error=>{
    if(error) return res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({error:error.code==='LIMIT_FILE_SIZE'?'Photo must be 5 MiB or smaller.':'Choose exactly one photo.'});
    const mime=imageMime(req.file?.buffer);
    if(!req.file) return res.status(400).json({error:'Choose a photo.'});
    if(!mime || req.file.mimetype!==mime) return res.status(415).json({error:'Choose a PNG, JPEG or WebP photo matching its file type.'});
    const id=randomUUID();
    db.run('INSERT INTO images (id,mimeType,data) VALUES (?,?,?)',[id,mime,req.file.buffer],error=>{
      if(error) return res.status(503).json({error:'Photo could not be saved. Please retry.'});
      res.status(201).json({url:`/api/images/${id}`});
    });
  }));
  app.get('/api/images/:id',...guards,(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(!imageId.test(req.params.id)) return res.status(404).json({error:'Photo not found.'});
    db.get('SELECT mimeType,data FROM images WHERE id=?',[req.params.id],(error,row)=>{
      if(error) return res.status(503).json({error:'Photo could not be loaded.'});
      if(!row || imageMime(row.data)!==row.mimeType) return res.status(404).json({error:'Photo not found.'});
      res.setHeader('Content-Type',row.mimeType);res.send(row.data);
    });
  });
}
module.exports={registerImageRoutes,MAX_IMAGE_BYTES,imageMime};
