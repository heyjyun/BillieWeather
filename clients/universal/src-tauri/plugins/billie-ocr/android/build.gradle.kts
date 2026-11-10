import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// Single source of truth for the engine version reported in `engine.version`.
// Bundled model artifact: the model ships inside the APK and runs on-device. Do NOT switch to
// `com.google.android.gms:play-services-mlkit-text-recognition*`, which downloads the model
// through Google Play services at runtime.
val mlkitTextChineseVersion = "16.0.1"

android {
    namespace = "app.billieweather.ocr"
    compileSdk = 36

    defaultConfig {
        // ML Kit text recognition v2 requires API 23+; Tauri 2 apps default to 24.
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        buildConfigField("String", "MLKIT_TEXT_VERSION", "\"text-recognition-chinese:$mlkitTextChineseVersion\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation("com.google.mlkit:text-recognition-chinese:$mlkitTextChineseVersion")
    // Tasks.await(...) is used on the plugin's background executor. Already a transitive
    // dependency of ML Kit; declared so it is on the compile classpath explicitly.
    implementation("com.google.android.gms:play-services-tasks:18.2.0")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation(project(":tauri-android"))
}
