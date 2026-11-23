import {
  Annotation,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";

const State = Annotation.Root({ actionId: Annotation<string>() });

/** 检查点只记录操作编号，凭证与订单明细由服务端按用户读取。 */
export function createApprovalFlow(
  saver: BaseCheckpointSaver,
  execute: (id: string) => Promise<void>,
) {
  const graph = new StateGraph(State)
    .addNode("review", ({ actionId }) => {
      const answer = interrupt({ actionId });
      if (answer !== actionId) throw new Error("确认信息与操作不匹配");
      return {};
    })
    .addNode("submit", async ({ actionId }) => {
      await execute(actionId);
      return {};
    })
    .addEdge(START, "review")
    .addEdge("review", "submit")
    .addEdge("submit", END)
    .compile({ checkpointer: saver });
  const config = (id: string) => ({
    configurable: { thread_id: "action/" + id },
  });
  return {
    prepare: (id: string) => graph.invoke({ actionId: id }, config(id)),
    confirm: (id: string) =>
      graph.invoke(new Command({ resume: id }), config(id)),
  };
}
