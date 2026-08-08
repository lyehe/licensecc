export const openApiDocument = {
  components: {
    schemas: {
      Policy: { type: "object" },
      Policy: { type: "string" }
    }
  },
  paths: {
    "/v1/policies": {
      get: { operationId: "listPolicies" },
      get: { operationId: "listPoliciesAgain" }
    }
  }
};
