import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
const scenario = createCardTestScenario('conclave-tribnal-viewer-convoke-szeras'.replace('tribnal','tribunal'), 'debug')!;
const requests=[];
for (let count=0;count<100;count++) {
 const step=scenario.engine.advance(); if(step.kind==='gameOver')break; if(step.kind==='continue')continue;
 const req=step.request;
 requests.push([req.prompt,req.legalActions.map(a=>[a.type,a.description])]);
 const action=req.legalActions.find(a=>a.description.includes('Cast Conclave Tribunal'))??req.legalActions.find(a=>a.type==='pass')??req.legalActions[0]!;
 const slots=action.interaction?.kind==='source'?action.interaction.targetSlots??action.targets:action.targets;
 scenario.engine.submit({requestId:req.requestId,actionId:action.id,...(slots?.length?{targets:slots.map(s=>({slot:s.slot,choice:s.options[0]!}))}:{})});
}
console.log(JSON.stringify({requests,state:scenario.engine.getState(),result:scenario.engine.getResult()},null,2));
