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
          result(file, "failed", message: "Not processed because this batch reached its processing time limit. Upload this file again in a smaller batch.")
        else
          import_file(file)
        end
      end
    end

    private

    def validate_batch!
      unless @files.is_a?(Array)
        raise StatementImporter::ImportError, "Choose one or more CSV or PDF files."
      end
      @files = @files.reject { |file| file.nil? || file == "" }
      raise StatementImporter::ImportError, "Choose one or more CSV or PDF files." if @files.empty?
      if @files.length > MAX_FILES
        raise StatementImporter::ImportError, "Choose at most #{MAX_FILES} files per upload. No files from this batch were imported."
      end
      unless @files.all? { |file| file.respond_to?(:read) && file.respond_to?(:rewind) && file.respond_to?(:size) && file.respond_to?(:original_filename) }
        raise StatementImporter::ImportError, "The selected files could not be read. Choose your CSV or PDF files again."
      end
      if @files.sum(&:size) > MAX_TOTAL_BYTES
        raise StatementImporter::ImportError, "The selected files exceed the 10 MB batch limit. No files from this batch were imported."
      end
    end

    def import_file(file)
      if file.size > StatementImporter::MAX_BYTES
        raise StatementImporter::ImportError, "Each statement must be 2 MB or smaller."
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
            message: "Already imported. Added the missing account and balance details; no transactions were duplicated.")
        else
          result(file, "imported", transaction_count: statement.transaction_count, date_column: importer.date_column_used,
            message: "Imported successfully.")
        end
      end
    rescue StatementImporter::ImportError => error
      result(file, "failed", message: error.message)
    end

    def import_pdf(file)
      checksum = Digest::SHA256.hexdigest(file.read(StatementImporter::MAX_BYTES + 1))
      file.rewind
      if Statement.exists?(user: @user, sha256: checksum)
        raise StatementImporter::ImportError, "This exact statement has already been imported."
      end
      draft = StatementDraft.active.find_by(user: @user, sha256: checksum, currency: @currency)
      existing_review = draft.present?
      draft ||= PdfStatementExtractor.new(user: @user, file: file, currency: @currency).call
      unless draft.auto_importable?
        return result(file, "review", draft: draft, transaction_count: draft.rows.length,
          message: existing_review ? "This PDF is already awaiting review. Open the existing draft below." : "Review the unclear dates or amounts before importing.")
      end

      # Draft deletion and the imported rows must succeed together.
      statement = Statement.transaction { DraftImport.new(user: @user, draft: draft).call }
      result(file, "imported", transaction_count: statement.transaction_count,
        message: "PDF imported automatically. Compare its transaction count with your statement.")
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
