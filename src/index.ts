// Entry point.
//
// Both imports are side-effect imports: config validates the environment, and
// app builds the Express server and starts listening. Do not import a binding
// here without using it, because TypeScript elides unused imports and the
// server would silently never start.
import './config';
import './app';
