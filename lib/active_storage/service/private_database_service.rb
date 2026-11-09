require "active_storage/service"

module ActiveStorage
  # An Active Storage service that keeps file bytes in Postgres (private_storage_files).
  #
  # Used for small, sensitive files such as payment QR codes:
  # * persistent: the hosting plan's disk is wiped on every deploy, the database is not;
  # * private: it never produces a URL. Files are only readable through an app
  #   controller that checks authorization and calls #download. Active Storage's own
  #   blob/representation routes refuse blobs on this service
  #   (config/initializers/private_active_storage.rb).
  class Service::PrivateDatabaseService < Service
    def initialize(public: false, **)
      raise ArgumentError, "PrivateDatabaseService cannot be public" if public
      @public = false
    end

    def upload(key, io, checksum: nil, **)
      instrument :upload, key: key, checksum: checksum do
        io.rewind if io.respond_to?(:rewind)
        data = io.read.to_s.b
        if checksum && ActiveStorage.checksum_implementation.base64digest(data) != checksum
          raise ActiveStorage::IntegrityError
        end
        PrivateStorageFile.upsert({key: key, data: data, byte_size: data.bytesize}, unique_by: :key)
      end
    end

    def download(key, &block)
      if block
        instrument(:streaming_download, key: key) { yield data_for(key) }
      else
        instrument(:download, key: key) { data_for(key) }
      end
    end

    def download_chunk(key, range)
      instrument(:download_chunk, key: key, range: range) { data_for(key).byteslice(range) }
    end

    def delete(key)
      instrument(:delete, key: key) { PrivateStorageFile.where(key: key).delete_all }
    end

    def delete_prefixed(prefix)
      instrument(:delete_prefixed, prefix: prefix) do
        PrivateStorageFile.where("key LIKE ?", "#{PrivateStorageFile.sanitize_sql_like(prefix)}%").delete_all
      end
    end

    def exist?(key)
      instrument(:exist, key: key) do |payload|
        payload[:exist] = PrivateStorageFile.exists?(key: key)
      end
    end

    def url_for_direct_upload(*, **)
      raise NotImplementedError, "PrivateDatabaseService does not support direct uploads"
    end

    def compose(*, **)
      raise NotImplementedError, "PrivateDatabaseService does not support compose"
    end

    private

    # There is no URL for these files, by design.
    def private_url(*, **)
      raise ActiveStorage::Error, "PrivateDatabaseService files have no URL; serve them through an authorizing controller"
    end

    def data_for(key)
      PrivateStorageFile.where(key: key).pick(:data)&.b || raise(ActiveStorage::FileNotFoundError)
    end
  end
end
