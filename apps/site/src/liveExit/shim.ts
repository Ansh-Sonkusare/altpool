// websnark and circomlib read the global Buffer. Import this module before any of them.
import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
