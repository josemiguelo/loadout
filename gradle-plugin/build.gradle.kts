plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-gradle-plugin`
    `maven-publish`
}

// The plugin a config repo applies: Kotlin/JVM over the repo's manifest
// files, the DSL on the classpath, and `loadoutCompile` writing the lock.
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    // Glob: the plugin compiles exactly the files the lock's hash covers.
    implementation(project(":model"))
    implementation(libs.kotlin.gradle.plugin)
}

gradlePlugin {
    plugins {
        create("loadout") {
            id = "io.github.josemiguelo.loadout"
            implementationClass = "loadout.gradle.LoadoutPlugin"
        }
    }
}

tasks.jar {
    // The plugin adds the DSL at its own version.
    manifest { attributes("Implementation-Version" to project.version) }
}

publishing {
    repositories {
        maven {
            name = "bundle"
            url = uri(rootProject.layout.buildDirectory.dir("bundle/maven"))
        }
    }
}
