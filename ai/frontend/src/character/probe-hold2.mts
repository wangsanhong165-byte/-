// 症状更精确复现: "只有 angry 出来" = 第一段情绪永远 angry?
// 真实链路: submitPresentation -> policy.expression -> exprCtrl.apply
// 查 character_step: ctx.emotion 是 commit 后的持久 state, 第一段是什么?
// 关键测试: segment 情绪到达前端后的 'runtime:character.intent' 载荷
// 先看提交侧: controllers.ts 574 行的 intent 流 + exprCtrl.apply 的调用点
