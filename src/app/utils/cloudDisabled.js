export const CLOUD_UNAVAILABLE = 'Secure cloud synchronization has not been configured.';

export function createDisabledCloudClient() {
  const result = () => ({ data: null, error: { message: CLOUD_UNAVAILABLE, code: 'CLOUD_NOT_CONFIGURED' }, status: 503, statusText: 'Service Unavailable' });
  const query = () => {
    const settled = Promise.resolve(result());
    let chain;
    chain = new Proxy({}, {
      get(_target, property) {
        if (['then', 'catch', 'finally'].includes(property)) return settled[property].bind(settled);
        return () => chain;
      },
    });
    return chain;
  };
  return {
    from: query,
    rpc: query,
    storage: { from: () => ({
      upload: async () => result(),
      remove: async () => result(),
      createSignedUrl: async () => result(),
      getPublicUrl: () => result(),
    }) },
  };
}
