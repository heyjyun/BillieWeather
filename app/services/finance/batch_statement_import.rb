require "digest"

module Finance
  class BatchStatementImport
    MAX_FILES = 10
    MAX_TOTAL_BYTES = 10 * 1024 * 1024
    MAX_PROCESSING_SECONDS = 25

    def initialize(user:, files:, currency:, date_column: nil)
      @user = user
      @files = files
      @currency = currency
      @date_column = date_column
    end

    def call
      validate_batch!
      started_at = monotonic_time
      @files.map do |file|
        if monotonic_time - started_at >= MAX_PROCESSING_SECONDS
          result(file, "failed", message: I18n.t("billie.backend.batch_timed_out"))
        else
          import_file(file)
        end
      end
    end

    private

    def validate_batch!
      unless @files.is_a?(Array)
        raise StatementImporter::ImportError, I18n.t("billie.backend.choose_files")
      end
      @files = @files.reject { |file| file.nil? || file == "" }
      raise StatementImporter::ImportError, I18n.t("billie.backend.choose_files") if @files.empty?
      if @files.length > MAX_FILES
        raise StatementImporter::ImportError, I18n.t("billie.backend.batch_file_limit", count: MAX_FILES)
      end
      unless @files.all? { |file| file.respond_to?(:read) && file.respond_to?(:rewind) && file.respond_to?(:size) && file.respond_to?(:original_filename) }
        raise StatementImporter::ImportError, I18n.t("billie.backend.unreadable_files")
      end
      if @files.sum(&:size) > MAX_TOTAL_BYTES
        raise StatementImporter::ImportError, I18n.t("billie.backend.batch_size_limit")
      end
    end

    def import_file(file)
      if file.size > StatementImporter::MAX_BYTES
        raise StatementImporter::ImportError, I18n.t("billie.backend.file_size_limit")
      end
      file.rewind
      prefix = file.read(5)
      file.rewind
      if prefix == "%PDF-" || File.extname(file.original_filename.to_s).downcase == ".pdf"
        import_pdf(file)
      else
        importer = StatementImporter.new(user: @user, file: file, currency: @currency, date_column: @date_column)
        # Include post-import categorization in this file's atomic transaction.
        statement = Statement.transaction { importer.call }
        if importer.refreshed?
          result(file, "imported", date_column: importer.date_column_used,
            message: I18n.t("billie.backend.import_details_refreshed"))
        else
          result(file, "imported", transaction_count: statement.transaction_count, date_column: importer.date_column_used,
            message: I18n.t("billie.backend.import_success"))
        end
      end
    rescue StatementImporter::ImportError => error
      result(file, "failed", message: error.message)
    end

    def import_pdf(file)
      checksum = Digest::SHA256.hexdigest(file.read(StatementImporter::MAX_BYTES + 1))
      file.rewind
      if Statement.exists?(user: @user, sha256: checksum)
        raise StatementImporter::ImportError, I18n.t("billie.backend.statement_duplicate")
      end
      draft = StatementDraft.active.find_by(user: @user, sha256: checksum, currency: @currency)
      existing_review = draft.present?
      draft ||= PdfStatementExtractor.new(user: @user, file: file, currency: @currency).call
      unless draft.auto_importable?
        return result(file, "review", draft: draft, transaction_count: draft.rows.length,
          message: existing_review ? I18n.t("billie.backend.pdf_existing_review") : I18n.t("billie.backend.pdf_review_unclear"))
      end

      # Draft deletion and the imported rows must succeed together.
      statement = Statement.transaction { DraftImport.new(user: @user, draft: draft).call }
      result(file, "imported", transaction_count: statement.transaction_count,
        message: I18n.t("billie.backend.pdf_auto_imported"))
    rescue StatementImporter::ImportError => error
      if draft&.persisted?
        result(file, "review", draft: draft, transaction_count: draft.rows.length, message: error.message)
      else
        raise
      end
    end

    def result(file, status, message:, transaction_count: nil, date_column: nil, draft: nil)
      filename = File.basename(file.original_filename.to_s.tr("\\", "/"))
      {filename: filename, status: status, message: message, transaction_count: transaction_count,
       date_column: date_column, draft: draft}
    end

    def monotonic_time
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
end
