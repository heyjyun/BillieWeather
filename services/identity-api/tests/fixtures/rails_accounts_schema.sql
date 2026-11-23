-- Generated: pg_dump --schema-only of the Rails users/teams/memberships tables (from db/schema.rb).
-- Foreign keys to tables outside this subset (oauth_applications, invitations) are omitted.
-- Used only when the test database has no Rails schema. Regenerate after Rails migrations touch these tables.
CREATE TABLE public.memberships (
    id integer NOT NULL,
    user_id integer,
    team_id integer,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    invitation_id bigint,
    user_first_name character varying,
    user_last_name character varying,
    user_profile_photo_id character varying,
    user_email character varying,
    added_by_id bigint,
    platform_agent_of_id bigint,
    role_ids jsonb DEFAULT '[]'::jsonb,
    platform_agent boolean DEFAULT false
);
CREATE SEQUENCE public.memberships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.memberships_id_seq OWNED BY public.memberships.id;
CREATE TABLE public.teams (
    id integer NOT NULL,
    name character varying,
    slug character varying,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    being_destroyed boolean,
    time_zone character varying,
    locale character varying
);
CREATE SEQUENCE public.teams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.teams_id_seq OWNED BY public.teams.id;
CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying DEFAULT ''::character varying NOT NULL,
    encrypted_password character varying DEFAULT ''::character varying NOT NULL,
    reset_password_token character varying,
    reset_password_sent_at timestamp without time zone,
    remember_created_at timestamp without time zone,
    sign_in_count integer DEFAULT 0 NOT NULL,
    current_sign_in_at timestamp without time zone,
    last_sign_in_at timestamp without time zone,
    current_sign_in_ip inet,
    last_sign_in_ip inet,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    current_team_id integer,
    first_name character varying,
    last_name character varying,
    time_zone character varying,
    last_seen_at timestamp without time zone,
    profile_photo_id character varying,
    ability_cache jsonb,
    last_notification_email_sent_at timestamp without time zone,
    former_user boolean DEFAULT false NOT NULL,
    encrypted_otp_secret character varying,
    encrypted_otp_secret_iv character varying,
    encrypted_otp_secret_salt character varying,
    consumed_timestep integer,
    otp_required_for_login boolean,
    otp_backup_codes character varying[],
    locale character varying,
    platform_agent_of_id bigint,
    otp_secret character varying,
    failed_attempts integer DEFAULT 0 NOT NULL,
    unlock_token character varying,
    locked_at timestamp(6) without time zone,
    google_uid character varying,
    usage_region character varying(2),
    usage_region_pending boolean DEFAULT false NOT NULL,
    nickname character varying(40),
    supporter_recognition_public boolean DEFAULT false NOT NULL,
    cloud_database_name character varying(60),
    finance_ai_categorized_at timestamp(6) without time zone,
    finance_owner_uid uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT users_usage_region_allowed CHECK (((usage_region IS NULL) OR ((usage_region)::text = ANY (ARRAY[('AE'::character varying)::text, ('AR'::character varying)::text, ('AT'::character varying)::text, ('AU'::character varying)::text, ('BD'::character varying)::text, ('BE'::character varying)::text, ('BG'::character varying)::text, ('BR'::character varying)::text, ('CA'::character varying)::text, ('CH'::character varying)::text, ('CL'::character varying)::text, ('CN'::character varying)::text, ('CO'::character varying)::text, ('CY'::character varying)::text, ('CZ'::character varying)::text, ('DE'::character varying)::text, ('DK'::character varying)::text, ('EE'::character varying)::text, ('EG'::character varying)::text, ('ES'::character varying)::text, ('FI'::character varying)::text, ('FR'::character varying)::text, ('GB'::character varying)::text, ('GR'::character varying)::text, ('HK'::character varying)::text, ('HR'::character varying)::text, ('HU'::character varying)::text, ('ID'::character varying)::text, ('IE'::character varying)::text, ('IL'::character varying)::text, ('IN'::character varying)::text, ('IT'::character varying)::text, ('JP'::character varying)::text, ('KE'::character varying)::text, ('KR'::character varying)::text, ('KW'::character varying)::text, ('LK'::character varying)::text, ('LT'::character varying)::text, ('LU'::character varying)::text, ('LV'::character varying)::text, ('MA'::character varying)::text, ('MO'::character varying)::text, ('MT'::character varying)::text, ('MX'::character varying)::text, ('MY'::character varying)::text, ('NG'::character varying)::text, ('NL'::character varying)::text, ('NO'::character varying)::text, ('NZ'::character varying)::text, ('PE'::character varying)::text, ('PH'::character varying)::text, ('PK'::character varying)::text, ('PL'::character varying)::text, ('PR'::character varying)::text, ('PT'::character varying)::text, ('QA'::character varying)::text, ('RO'::character varying)::text, ('RU'::character varying)::text, ('SA'::character varying)::text, ('SE'::character varying)::text, ('SG'::character varying)::text, ('SI'::character varying)::text, ('SK'::character varying)::text, ('TH'::character varying)::text, ('TR'::character varying)::text, ('TW'::character varying)::text, ('UA'::character varying)::text, ('US'::character varying)::text, ('VN'::character varying)::text, ('XG'::character varying)::text, ('XO'::character varying)::text, ('ZA'::character varying)::text])))),
    CONSTRAINT users_usage_region_required CHECK (((usage_region IS NOT NULL) OR usage_region_pending OR (platform_agent_of_id IS NOT NULL)))
);
CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;
ALTER TABLE ONLY public.memberships ALTER COLUMN id SET DEFAULT nextval('public.memberships_id_seq'::regclass);
ALTER TABLE ONLY public.teams ALTER COLUMN id SET DEFAULT nextval('public.teams_id_seq'::regclass);
ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
CREATE INDEX index_memberships_on_added_by_id ON public.memberships USING btree (added_by_id);
CREATE INDEX index_memberships_on_invitation_id ON public.memberships USING btree (invitation_id);
CREATE INDEX index_memberships_on_platform_agent_of_id ON public.memberships USING btree (platform_agent_of_id);
CREATE INDEX index_memberships_on_team_id ON public.memberships USING btree (team_id);
CREATE INDEX index_memberships_on_user_id ON public.memberships USING btree (user_id);
CREATE UNIQUE INDEX index_users_on_email ON public.users USING btree (email);
CREATE UNIQUE INDEX index_users_on_finance_owner_uid ON public.users USING btree (finance_owner_uid);
CREATE UNIQUE INDEX index_users_on_google_uid ON public.users USING btree (google_uid) WHERE (google_uid IS NOT NULL);
CREATE INDEX index_users_on_platform_agent_of_id ON public.users USING btree (platform_agent_of_id);
CREATE UNIQUE INDEX index_users_on_reset_password_token ON public.users USING btree (reset_password_token);
CREATE UNIQUE INDEX index_users_on_unlock_token ON public.users USING btree (unlock_token);
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT fk_rails_688bbf8b6a FOREIGN KEY (added_by_id) REFERENCES public.memberships(id);
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT fk_rails_99326fb65d FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT fk_rails_ae2aedcfaf FOREIGN KEY (team_id) REFERENCES public.teams(id);
