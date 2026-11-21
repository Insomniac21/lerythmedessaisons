import { createHandler } from "./handler.js";

const handle = createHandler();

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
