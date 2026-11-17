import { configure } from "@testing-library/dom";

// Cold SQL/WASM initialization and lazy page loading can exceed the DOM library's 1s default.
// Keep assertions unchanged and wait for the condition instead of adding arbitrary sleeps.
configure({ asyncUtilTimeout: 3000 });
