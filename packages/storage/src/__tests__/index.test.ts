import app from '@flamelink/sdk-app'

describe('Storage Module', () => {
  beforeAll(() => {
    jest.spyOn(app, '_registerModule')
  })

  test('should register itself with the Flamelink app', async () => {
    await import('../')
    expect(app._registerModule).toHaveBeenCalledWith(
      'storage',
      expect.any(Function)
    )
  })
})
