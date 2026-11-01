/**
 * Vitest setup (ADR 0034 decision 8): every game a test runs with `strictInvariants` checks the
 * whole-state invariants after state-based actions at each priority checkpoint.
 */
import { installStateInvariants } from '../src/testing/invariants';

installStateInvariants();
