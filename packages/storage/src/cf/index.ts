import compose from 'compose-then'
import values from 'lodash/values'
import isPlainObject from 'lodash/isPlainObject'
import find from 'lodash/find'
import get from 'lodash/get'
import set from 'lodash/set'
import resizeImage from 'browser-image-resizer'
import flamelink from '@flamelink/sdk-app'
import {
  FlamelinkStorageFactory,
  StoragePublicApi,
  GetFilesArgsForCF,
  ImageSize,
  FolderObject,
  FileObject
} from '@flamelink/sdk-storage-types'
import {
  applyOptionsForCF,
  pluckResultFields,
  processReferencesForCF,
  formatStructure,
  FlamelinkError,
  logWarning
} from '@flamelink/sdk-utils'
import {
  filterFilesByFolderId,
  getScreenResolution,
  getStorageRefPath
} from '../helpers'
import { DEFAULT_REQUIRED_IMAGE_SIZE } from '../constants'

const FILES_COLLECTION = 'fl_files'
const FOLDERS_COLLECTION = 'fl_folders'

const factory: FlamelinkStorageFactory = function(context) {
  const api: StoragePublicApi = {
    async _getFolderId({ folderName = '' }) {
      if (!folderName) {
        return null
      }

      const foldersSnapshot = await api.folderRef().get()
      const folders: FolderObject[] = []
      foldersSnapshot.forEach((doc: any) => folders.push(doc.data()))
      const folder = find(folders, { name: folderName })

      if (!folder) {
        return folder
      }

      return folder.id
    },

    async _getFolderIdFromOptions(
      { folderId, folderName } = {
        folderId: '',
        folderName: ''
      }
    ) {
      if (folderId) {
        return folderId
      }

      return api._getFolderId({ folderName })
    },

    async _setFile(filePayload: FileObject) {
      const payload = Object.assign({}, filePayload, {
        __meta__: {
          createdBy: get(context, 'services.auth.currentUser.uid', 'UNKNOWN'),
          createdDate: new Date().toISOString()
        }
      })

      return api.fileRef(filePayload.id).set(payload)
    },

    async _createSizedImage(
      fileData: any,
      filename: string,
      options: ImageSize = {}
    ) {
      if (options && (options.path || options.width || options.maxWidth)) {
        const resizedImage = await resizeImage(fileData, options)
        return api
          .ref(filename, {
            path: options.path,
            width: options.width || options.maxWidth
          })
          .put(resizedImage)
      }
      throw new FlamelinkError(
        `Invalid size object supplied - please refer to https://flamelink.github.io/flamelink-js-sdk/#/storage?id=upload for more details on upload options.\nImage upload for supplied size skipped for file: ${filename}`
      )
    },

    ref(filename, { ...options }) {
      if (context.isNodeEnvironment && !context.usesAdminApp) {
        throw new FlamelinkError(`
        The Firebase client-side SDK cannot access the Storage Bucket server-side.
        Please use the admin SDK instead - https://www.npmjs.com/package/firebase-admin

        Instructions here: https://flamelink.github.io/flamelink-js-sdk/#/getting-started?id=usage
        `)
      }

      const storageService = flamelink._ensureService('storage', context)

      // Check if the filename is a URL (contains "://")
      if (/:\/\//.test(filename)) {
        if (context.usesAdminApp) {
          throw new FlamelinkError(
            'Retrieving files from URL is not supported for the admin SDK'
          )
        }
        return storageService.refFromURL(filename)
      }

      return context.usesAdminApp
        ? storageService
            .bucket()
            .file(getStorageRefPath(filename, options as ImageSize))
        : storageService.ref(getStorageRefPath(filename, options))
    },

    folderRef(folderId) {
      const firestoreService = flamelink._ensureService('firestore', context)

      return folderId
        ? firestoreService.collection(FOLDERS_COLLECTION).doc(folderId)
        : firestoreService.collection(FOLDERS_COLLECTION)
    },

    fileRef(fileId) {
      const firestoreService = flamelink._ensureService('firestore', context)

      return fileId
        ? firestoreService.collection(FILES_COLLECTION).doc(fileId)
        : firestoreService.collection(FILES_COLLECTION)
    },

    async getFoldersRaw({ ...options }) {
      return applyOptionsForCF(api.folderRef(), options).get({
        source: options.source || 'default'
      })
    },

    async getFolders({ ...options }) {
      const pluckFields = pluckResultFields(options.fields)
      const structureItems = formatStructure(options.structure, {
        idProperty: 'id',
        parentProperty: 'parentId'
      })
      const processRefs = processReferencesForCF(options)
      const snapshot = await api.getFoldersRaw(options)

      if (snapshot.empty) {
        return []
      }

      const folderPromises: any[] = []
      snapshot.forEach(async (doc: any) =>
        folderPromises.push(processRefs(doc.data()))
      )

      const folders = await Promise.all(folderPromises)

      return compose(
        pluckFields,
        structureItems
      )(folders)
    },

    async getFileRaw({ fileId, ...options }) {
      if (!fileId) {
        throw new FlamelinkError(
          '"storage.getFileRaw()" should be called with at least the file ID'
        )
      }

      return applyOptionsForCF(api.fileRef(fileId), options).get({
        source: options.source || 'default'
      })
    },

    async getFile({ fileId, ...options }) {
      if (!fileId) {
        throw new FlamelinkError(
          '"storage.getFile()" should be called with at least the file ID'
        )
      }
      const pluckFields = pluckResultFields(options.fields)
      const processRefs = processReferencesForCF(options)
      const snapshot = await api.getFileRaw({ fileId, ...options })

      const docData = await pluckFields({
        [fileId]: await processRefs(snapshot.data())
      })
      return docData[fileId]
    },

    async getFilesRaw({ ...options }) {
      return applyOptionsForCF(api.fileRef(), options).get({
        source: options.source || 'default'
      })
    },

    async getFiles({ ...options }) {
      const defaultOptions: GetFilesArgsForCF = {}
      const opts = Object.assign(
        defaultOptions,
        options,
        options.mediaType
          ? {
              orderByChild: 'type',
              equalTo: options.mediaType
            }
          : {}
      )
      const folderId = await api._getFolderIdFromOptions(opts)
      const filterFolders = filterFilesByFolderId(folderId)
      const pluckFields = pluckResultFields(opts.fields)
      const processRefs = processReferencesForCF(options)
      const snapshot = await api.getFilesRaw(opts)

      if (snapshot.empty) {
        return []
      }

      const filePromises: any[] = []
      snapshot.forEach(async (doc: any) =>
        filePromises.push(processRefs(doc.data()))
      )

      const files = await Promise.all(filePromises)

      return compose(
        pluckFields,
        filterFolders
      )(files)
    },

    async getURL({ fileId, ...options }) {
      if (!fileId) {
        throw new FlamelinkError(
          '"storage.getURL()" should be called with at least the file ID'
        )
      }

      const { size } = options
      const file = await api.getFile({ fileId, ...options })

      if (!file) {
        return file
      }

      const { file: filename, sizes: availableFileSizes } = file
      const storageRefArgs = { filename, options: {} }

      const getImagePathByClosestSize = (minSize: number) => {
        const smartWidth = availableFileSizes
          .map(
            availableSize =>
              Object.assign({}, availableSize, {
                width: parseInt(
                  availableSize.width || availableSize.maxWidth,
                  10
                )
              }),
            []
          )
          .sort((a, b) => a.width - b.width) // sort widths ascending
          .find(availableSize => availableSize.width >= minSize)

        if (smartWidth) {
          storageRefArgs.options = Object.assign(
            storageRefArgs.options,
            smartWidth
          )
        } else {
          logWarning(
            `The provided size (${size}) has been ignored because it did not match any of the given file's available sizes.\nAvailable sizes: ${availableFileSizes
              .map(availableSize => availableSize.width)
              .join(', ')}`
          )
        }
      }

      if (isPlainObject(size)) {
        const { width, height, quality } = size as ImageSize

        if (width && height && quality) {
          size.path = `${width}_${height}_${Math.round(
            parseFloat(quality.toString()) * 100
          )}`
        }

        // For images with `path` value
        if (size.path && get(availableFileSizes, '[0].path')) {
          if (
            availableFileSizes.find(
              ({ path: filePath }) => filePath === size.path
            )
          ) {
            storageRefArgs.options = Object.assign(storageRefArgs.options, {
              path: size.path
            })
          } else {
            logWarning(
              `The provided path (${
                size.path
              }) has been ignored because it did not match any of the given file's available paths.\nAvailable paths: ${availableFileSizes
                .map(availableSize => availableSize.path)
                .join(', ')}`
            )
          }
        } else if (width && availableFileSizes && availableFileSizes.length) {
          getImagePathByClosestSize(parseInt(width.toString(), 10))
        }
      } else if (
        typeof size === 'string' &&
        availableFileSizes &&
        availableFileSizes.length
      ) {
        // This part is for the special 'device' use case and for the legacy width setting
        const minSize = size === 'device' ? getScreenResolution() : size
        getImagePathByClosestSize(Number(minSize))
      }

      const fileRef = await api.ref(
        storageRefArgs.filename,
        storageRefArgs.options
      )

      if (context.usesAdminApp) {
        const signedUrls = await fileRef.getSignedUrl({
          action: 'read',
          expires: '01-01-2500' // Just expire at some very far time in the future
        })
        return get(signedUrls, '[0]', '')
      }

      return fileRef.getDownloadURL()
    },

    async getMetadata({ fileId, ...options }) {
      if (!fileId) {
        throw new FlamelinkError(
          '"storage.getMetadata()" should be called with at least the file ID'
        )
      }

      const file = await api.getFile({ fileId, ...options })

      if (!file) {
        throw new FlamelinkError(`There is no file for File ID: "${fileId}"`)
      }

      const { file: filename } = file

      return api.ref(filename).getMetadata()
    },

    async updateMetadata({ fileId, updates }) {
      if (!fileId || !updates) {
        throw new FlamelinkError(
          '"storage.updateMetadata()" should be called with the "fileID" and the "updates" object'
        )
      }

      const file = await api.getFile({ fileId })

      if (!file) {
        throw new FlamelinkError(`There is no file for File ID: "${fileId}"`)
      }

      const { file: filename } = file

      return api.ref(filename).updateMetadata(updates)
    },

    async deleteFile({ fileId, ...options }) {
      if (context.usesAdminApp) {
        throw new FlamelinkError(
          '"storage.deleteFile()" is not currently supported for server-side use.'
        )
      }

      if (!fileId) {
        throw new FlamelinkError(
          '"storage.deleteFile()" should be called with at least the file ID'
        )
      }

      const file = await api.getFile({ fileId, ...options })

      if (!file) {
        return file
      }

      const { file: filename, sizes } = file
      const storageRef = api.ref(filename)

      // Delete original file from storage bucket
      await storageRef.delete()

      // If sizes are set, delete all the resized images here
      if (Array.isArray(sizes)) {
        await Promise.all(
          sizes.map(async size => {
            const width = size.width || size.maxWidth
            const { path } = size

            if (!width && !path) {
              return Promise.resolve()
            }

            return api.ref(filename, { width, path }).delete()
          })
        )
      }

      // Delete file entry from the real-time db
      return api.fileRef(fileId).remove()
    },

    async upload(fileData, options = {}) {
      if (context.usesAdminApp) {
        throw new FlamelinkError(
          '"storage.upload()" is not currently supported for server-side use.'
        )
      }
      const { sizes: userSizes, overwriteSizes } = options
      const settingsImageSizes = await get(
        context,
        'modules.settings'
      ).getImageSizes()

      if (settingsImageSizes) {
        if (!userSizes && !overwriteSizes) {
          set(options, 'sizes', settingsImageSizes || [])
        } else if (userSizes && userSizes.length && !overwriteSizes) {
          set(options, 'sizes', [...settingsImageSizes, ...userSizes] || [])
        }
      }

      // Ensure image size with width DEFAULT_REQUIRED_IMAGE_SIZE exists
      // Flamelink CMS expects file to reside in `240` folder, so size if only `width: 240` should be passed
      if (
        !options.sizes ||
        ((options.sizes && options.sizes.length === 0) ||
          (Array.isArray(options.sizes) &&
            options.sizes.filter(
              size =>
                (size.width === DEFAULT_REQUIRED_IMAGE_SIZE ||
                  size.maxWidth === DEFAULT_REQUIRED_IMAGE_SIZE) &&
                !size.height &&
                !size.quality
            ).length === 0))
      ) {
        if (Array.isArray(options.sizes)) {
          options.sizes.push({ width: DEFAULT_REQUIRED_IMAGE_SIZE })
        } else {
          set(options, 'sizes', [{ width: DEFAULT_REQUIRED_IMAGE_SIZE }])
        }
      }

      const id = Date.now().toString()
      const metadata = get(options, 'metadata', {} as any)
      const filename =
        (typeof fileData === 'object' && fileData.name) ||
        typeof metadata.name === 'string'
          ? `${id}_${metadata.name || fileData.name}`
          : id
      const storageRef = api.ref(filename, options as ImageSize)
      const updateMethod = typeof fileData === 'string' ? 'putString' : 'put'
      const args = [fileData]

      let folderId = await api._getFolderIdFromOptions(options)

      if (typeof folderId === 'number') {
        folderId = folderId.toString()
      }

      set(options, 'metadata.customMetadata.flamelinkFileId', id)
      set(options, 'metadata.customMetadata.flamelinkFolderId', folderId)
      args.push(options.metadata)

      // TODO: Test and verify how the Firebase SDK handles string uploads with encoding and metadata
      // Is it the second argument then or should it be passed along with the metadata object?
      if (updateMethod === 'putString' && options.stringEncoding) {
        args.splice(1, 0, options.stringEncoding)
      }

      // Upload original file to storage bucket
      const uploadTask = storageRef[updateMethod](...args)
      const snapshot = await uploadTask

      const mediaType = /^image\//.test(get(snapshot, 'metadata.contentType'))
        ? 'images'
        : 'files'
      const filePayload: FileObject = {
        id,
        file: get(snapshot, 'metadata.name', ''),
        folderId,
        type: mediaType,
        contentType: get(snapshot, 'metadata.contentType', '')
      }

      // If mediaType === 'images', file is resizeable and sizes/widths are set, resize images here
      if (
        mediaType === 'images' &&
        updateMethod === 'put' &&
        Array.isArray(options.sizes)
      ) {
        filePayload.sizes = options.sizes.map(size => {
          const { width, height, quality } = size
          if (width && height && quality) {
            return Object.assign({}, size, {
              path: `${width}_${height}_${Math.round(
                parseFloat(quality.toString()) * 100
              )}`
            })
          }
          return size
        })

        await Promise.all(
          filePayload.sizes.map(size =>
            api._createSizedImage(fileData, filename, size)
          )
        )
      }

      // Write to db
      await api._setFile(filePayload)

      return uploadTask
    }
  }

  return api
}

export default factory
