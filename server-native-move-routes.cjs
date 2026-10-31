function registerNativeMoveRoutes(app,{requireAuth,runtime,listPendingMoves}={}) {
  const middleware=Array.isArray(requireAuth)?requireAuth:[requireAuth];
  if(!middleware.length||!middleware.every(handler=>typeof handler==='function')||typeof listPendingMoves!=='function'||!runtime)throw TypeError('Authenticated native move services are required.');
  const replyError=(res,error)=>res.status([400,401,403,404,409,503].includes(error.status)?error.status:503).json({error:error.status?error.message:'Transfer recovery is unavailable. Keep the original request and retry.',...(typeof error.code==='string'?{code:error.code}:{})});
  app.get('/api/native/reservation-moves',requireAuth,async(_req,res)=>{
    try{res.json({moves:await listPendingMoves()});}catch(error){replyError(res,error);}
  });
  app.post('/api/native/reservation-moves/recover',requireAuth,async(req,res)=>{
    try{
      const body=req.body;
      if(!body||Array.isArray(body)||Object.keys(body).length!==2||!Object.keys(body).every(key=>['requestId','action'].includes(key))||typeof body.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(body.requestId)||!['continue','abort'].includes(body.action))return res.status(400).json({error:'Choose the original transfer and a recovery action.'});
      const command={requestId:body.requestId,action:body.action};
      res.json(await (await runtime).recoverMove(req.authToken,command));
    }catch(error){replyError(res,error);}
  });
}
module.exports={registerNativeMoveRoutes};
