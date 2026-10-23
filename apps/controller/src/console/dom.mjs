// Some Node tests still reach this path through Console source imports. Remove this forwarder
// when those tests load the served modules or import a source graph Node can resolve directly.
export * from "./dom.mts";
